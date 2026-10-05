import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import dayjs, { type Dayjs } from "dayjs";
import { Alert, Button, Card, DatePicker, Input, Modal, Segmented, Select, Space, Table, Tag, Typography, Upload, message } from "antd";
import { useAuth } from "../../auth/AuthContext";
import { UploadOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtMoney, importPrices1C, listCurrencies, listPrices, type Import1CRow, type PriceListRow } from "../../api/prices";
import ResponsiveTable from "../../components/ResponsiveTable";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDate } from "../../utils/dates";

/** Прайс (05.10): плёнка и материалы с действующей ценой — в своей валюте
 * и в рублях по курсу; загрузка цен из 1С. Цена позиции правится в её
 * карточке (клик по строке). */
export default function PricesTab({ canManage }: { canManage: boolean }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<"all" | "plenka" | "material">("all");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const query = useQuery({ queryKey: ["prices", kind], queryFn: () => listPrices(kind === "all" ? undefined : kind) });
  const rows = (query.data ?? [])
    .filter((r) => !onlyMissing || r.price == null || r.rub == null)
    .filter((r) => !q.trim() || `${r.name} ${r.code_1c ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const all = query.data ?? [];
  const noPrice = all.filter((r) => r.price == null).length;
  const noRate = all.filter((r) => r.price != null && r.rub == null).length;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { value: "all", label: "Плёнка и материалы" },
            { value: "plenka", label: "Плёнка" },
            { value: "material", label: "Материалы" },
          ]}
        />
        <Input.Search allowClear placeholder="Название или код 1С" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type={onlyMissing ? "primary" : "default"} onClick={() => setOnlyMissing((v) => !v)}>
          Без цены {noPrice + noRate}
        </Button>
        {canManage && (
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
            Загрузить из 1С
          </Button>
        )}
      </Space>
      {noRate > 0 && (
        <Alert type="warning" showIcon message={`У ${noRate} позиций цена в валюте без курса — задайте курс в «Настройки → Валюты и курсы»`} />
      )}
      <ResponsiveTable<PriceListRow>
        exportTitle="Прайс: плёнка и материалы"
        size="small"
        rowKey="item_id"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        onRow={(r) => ({ onClick: () => navigate(`/item/${r.item_id}`), style: { cursor: "pointer" } })}
        columns={[
          { title: "Позиция", dataIndex: "name" },
          { title: "Вид", dataIndex: "kind" },
          { title: "Код 1С", render: (_, r) => r.code_1c ?? "" },
          {
            title: "Цена",
            render: (_, r) =>
              r.price == null ? <Typography.Text type="secondary">нет</Typography.Text> : `${fmtMoney(r.price, r.price_currency ?? "RUB")} / ${r.price_unit}`,
          },
          {
            title: "В рублях",
            render: (_, r) =>
              r.price == null ? "" : r.rub == null ? <Tag color="warning">нет курса</Tag> : `${fmtMoney(r.rub)} / ${r.price_unit}`,
          },
          { title: "Откуда", render: (_, r) => r.source ?? "" },
          { title: "С даты", render: (_, r) => (r.valid_from ? fmtDate(r.valid_from) : "") },
        ]}
      />
      {importOpen && <Import1CModal onClose={() => setImportOpen(false)} />}
    </Space>
  );
}

type Field = "code" | "name" | "price" | "currency";
const FIELD_LABEL: Record<Field, string> = { code: "Код 1С", name: "Наименование", price: "Цена", currency: "Валюта" };
const GUESS: Record<Field, RegExp> = {
  code: /^код|артикул/i,
  name: /наимен|номенклатур|товар/i,
  price: /цена|стоимость/i,
  currency: /валют/i,
};

/** Загрузка цен из выгрузки 1С: файл Excel/CSV → какие колонки что значат
 * (угадываются по заголовкам) → сопоставление с позициями без записи →
 * записать. Позиция ищется по коду 1С, потом по названию. */
function Import1CModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const curQ = useQuery({ queryKey: ["currencies"], queryFn: listCurrencies });
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<Partial<Record<Field, number>>>({});
  const [currency, setCurrency] = useState("RUB");
  const [validFrom, setValidFrom] = useState<Dayjs>(dayjs());
  const [result, setResult] = useState<Import1CRow[] | null>(null);

  const headers = table[headerRow] ?? [];
  const dataRows = useMemo(
    () =>
      table
        .slice(headerRow + 1)
        .filter((r) => r.some((c) => String(c ?? "").trim()))
        .map((r) => ({
          code: map.code != null ? String(r[map.code] ?? "") : undefined,
          name: map.name != null ? String(r[map.name] ?? "") : undefined,
          price: map.price != null ? r[map.price] : undefined,
          currency: map.currency != null ? String(r[map.currency] ?? "") : undefined,
        }))
        .filter((r) => (r.code || r.name) && String(r.price ?? "").trim() !== ""),
    [table, headerRow, map],
  );

  const readFile = async (file: File) => {
    const book = XLSX.read(await file.arrayBuffer());
    const sheet = book.Sheets[book.SheetNames[0]];
    const t = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: true, defval: "" });
    setTable(t);
    setFileName(file.name);
    setResult(null);
    // шапка — первая строка, где есть «цена»; колонки угадываем по названиям
    const h = Math.max(0, t.findIndex((r) => r.some((c) => GUESS.price.test(String(c)))));
    setHeaderRow(h);
    const guess: Partial<Record<Field, number>> = {};
    (t[h] ?? []).forEach((c, i) => {
      (Object.keys(GUESS) as Field[]).forEach((f) => {
        if (guess[f] == null && GUESS[f].test(String(c))) guess[f] = i;
      });
    });
    setMap(guess);
  };

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      importPrices1C({
        rows: dataRows,
        default_currency: currency,
        valid_from: validFrom.format("YYYY-MM-DD"),
        doc: fileName ? `1С: ${fileName}`.slice(0, 64) : undefined,
        dry_run: dryRun,
      }),
    onSuccess: (r, dryRun) => {
      setResult(r);
      if (!dryRun) {
        qc.invalidateQueries({ queryKey: ["prices"] });
        qc.invalidateQueries({ queryKey: ["item-prices"] });
        message.success(`Записано цен: ${r.filter((x) => !x.errors.length).length}`);
        onClose();
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось загрузить цены")),
  });
  const ok = (result ?? []).filter((r) => !r.errors.length).length;
  const colOptions = headers.map((h, i) => ({ value: i, label: `${i + 1}. ${String(h || "—")}` }));

  return (
    <Modal
      open
      width={1100}
      title="Цены из 1С"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button disabled={!dataRows.length || map.price == null} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
            Сопоставить
          </Button>
          <Button type="primary" disabled={!result || !ok} loading={run.isPending && run.variables === false} onClick={() => run.mutate(false)}>
            Записать {ok || ""}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Выгрузите из 1С прайс или список номенклатуры с ценами в Excel и выберите файл. Позиция ищется по коду 1С, потом по
          названию; найденная по названию запоминает код. Валюта — из колонки, если её нет — своя валюта позиции, иначе
          выбранная ниже.
        </Typography.Text>
        <Upload accept=".xlsx,.xls,.csv" maxCount={1} showUploadList={false} beforeUpload={(f) => (readFile(f), false)}>
          <Button icon={<UploadOutlined />}>{fileName || "Выбрать файл"}</Button>
        </Upload>
        {table.length > 0 && (
          <Space wrap align="end">
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">Строка заголовков</Typography.Text>
              <Select
                style={{ width: 120 }}
                value={headerRow}
                onChange={(v) => {
                  setHeaderRow(v);
                  setResult(null);
                }}
                options={table.slice(0, 30).map((_, i) => ({ value: i, label: `${i + 1}` }))}
              />
            </Space>
            {(Object.keys(FIELD_LABEL) as Field[]).map((f) => (
              <Space key={f} direction="vertical" size={2}>
                <Typography.Text type="secondary">
                  {FIELD_LABEL[f]}
                  {f === "price" ? " *" : ""}
                </Typography.Text>
                <Select
                  allowClear
                  style={{ width: 190 }}
                  placeholder="нет"
                  value={map[f]}
                  options={colOptions}
                  onChange={(v) => {
                    setMap((m) => ({ ...m, [f]: v }));
                    setResult(null);
                  }}
                />
              </Space>
            ))}
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">Валюта по умолчанию</Typography.Text>
              <Select
                style={{ width: 140 }}
                value={currency}
                onChange={setCurrency}
                options={(curQ.data ?? []).map((c) => ({ value: c.code, label: `${c.name} (${c.symbol})` }))}
              />
            </Space>
            <Space direction="vertical" size={2}>
              <Typography.Text type="secondary">Действует с</Typography.Text>
              <DatePicker format="DD.MM.YYYY" allowClear={false} value={validFrom} onChange={(d) => d && setValidFrom(d)} />
            </Space>
          </Space>
        )}
        {table.length > 0 && !result && (
          <Typography.Text type="secondary">Строк с ценой: {dataRows.length}. Нажмите «Сопоставить».</Typography.Text>
        )}
        {result && (
          <>
            <Alert
              type={ok === result.length ? "success" : "warning"}
              showIcon
              message={`Найдено и готово к записи: ${ok} из ${result.length}`}
              description={result.length - ok ? "Строки с ошибками не запишутся; позиции, которых нет в номенклатуре, заведите или поправьте название." : undefined}
            />
            <Table<Import1CRow>
              size="small"
              rowKey="line"
              dataSource={result}
              pagination={{ pageSize: 50 }}
              scroll={{ y: 380 }}
              columns={[
                { title: "Из 1С", render: (_, r) => [r.code, r.name].filter(Boolean).join(" · ") },
                { title: "Цена", render: (_, r) => (r.price != null ? `${r.price} ${r.currency ?? ""}` : "") },
                {
                  title: "Позиция",
                  render: (_, r) =>
                    r.item_name ? (
                      <>
                        {r.item_name} <Typography.Text type="secondary">({r.matched_by})</Typography.Text>
                      </>
                    ) : (
                      ""
                    ),
                },
                { title: "Была", render: (_, r) => r.old ?? "" },
                { title: "", render: (_, r) => r.errors.map((e) => <Tag key={e} color="red">{e}</Tag>) },
              ]}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}

/** Экран «Цены» (меню «Закупки»). */
export function PricesPage() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("prices.manage");
  return (
    <Card title="Цены">
      <PricesTab canManage={canManage} />
    </Card>
  );
}
