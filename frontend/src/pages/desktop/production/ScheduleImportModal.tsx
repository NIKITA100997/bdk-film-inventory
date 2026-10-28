import { useAuth } from "../../../auth/AuthContext";
import LineOptions from "../../../components/LineOptions";
import { useRef, useState } from "react";
import { Alert, Button, DatePicker, Input, Modal, Select, Space, Table, Tag, Typography, Upload, message } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listItemTypes } from "../../../api/itemTypes";
import { listMaterialSkus } from "../../../api/dictionaries";
import { importColumnsText } from "../nomenclature/ImportTemplateModal";
import {
  importOrderFromSchedule,
  type ProductionOrder,
  type ScheduleImportColor,
  type ScheduleImportRow,
} from "../../../api/productionOrders";
import { importCustomerOrders, readInvoiceFile } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { hasPerm } from "../../../auth/permissions";

/** Дата счёта из сделки: дата в названии («… 16.10», «… 12.10.26», «… 19.10.2026»),
 * иначе дата создания сделки. Дата без года — ближайшая прошедшая. */
function dealInvoiceDate(title: string, created?: string | null): Dayjs | null {
  const m = /(?:^|[\s,(])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\.?(?=$|[\s,)])/.exec(title);
  if (m) {
    const now = dayjs();
    let y = m[3] ? Number(m[3]) : now.year();
    if (y < 100) y += 2000;
    let d = dayjs(new Date(y, Number(m[2]) - 1, Number(m[1])));
    if (d.isValid() && d.date() === Number(m[1])) {
      if (!m[3] && d.isAfter(now, "day")) d = d.subtract(1, "year");
      return d;
    }
  }
  return created ? dayjs(created) : null;
}

const COLOR_STATUS: Record<ScheduleImportColor["status"], { color: string; text: string }> = {
  ok: { color: "green", text: "плёнка подобрана" },
  pet: { color: "blue", text: "ПЭТ 2Д/3Д — по детали" },
  choose: { color: "orange", text: "выберите толщину" },
  none: { color: "red", text: "плёнка не найдена" },
};

/** График запуска (лист «График» из Excel, колонки: Дата отгрузки, № счёта,
 * Серия, Размер, Цвет, Наименование, Кол-во дверей) → черновик заказа.
 * Строка — позиция по типу (находится или создаётся с техкартой по
 * правилам типа) и строка заказа. Сначала «Разобрать» — предпросмотр. */
export default function ScheduleImportModal({
  onClose,
  onCreated,
  target = "production",
  onCustomerCreated,
  fromDeal,
}: {
  onClose: () => void;
  onCreated?: (o: ProductionOrder) => void;
  /** customer — заказы клиентов (13.10): по одному на счёт, без запуска. */
  target?: "production" | "customer";
  onCustomerCreated?: (ids: number[]) => void;
  /** заказ из сделки Битрикс24 (19.10): счёт и клиент подставлены, сделка привяжется */
  fromDeal?: {
    id: number; title: string; invoice: string | null; company: string | null; amount: number | null; assignedBx: number | null;
    shipDate?: string | null; created?: string | null;
  };
}) {
  const forCustomer = target === "customer";
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  // Типы с шаблоном импорта (колонки графика и признаки — настройка типа).
  const gpTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === "izdelie" && t.is_active && t.name_template && t.import_template);
  // «По серии» (16.10): в счёте и графике — все двери, тип строки по серии
  // (щитовые, царговые…). Выбор одного типа — как раньше.
  const AUTO = 0;
  const [typeId, setTypeId] = useState<number | undefined>();
  const effectiveType = typeId ?? (gpTypes.length > 1 ? AUTO : gpTypes[0]?.id);
  const isAuto = effectiveType === AUTO;
  const selectedType = gpTypes.find((t) => t.id === effectiveType) ?? (isAuto ? gpTypes[0] : undefined);
  const sendType = isAuto ? null : (effectiveType as number);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  // счёт из 1С целиком (07.10): строки «наименование — кол-во», номер и отгрузка — здесь
  const [invoiceNo, setInvoiceNo] = useState(fromDeal?.invoice ?? "");
  // дата счёта (28.10): из сделки — дата в названии или дата сделки; из файла 1С — если есть в шапке
  const [invoiceDate, setInvoiceDate] = useState<Dayjs | null>(fromDeal ? dealInvoiceDate(fromDeal.title, fromDeal.created) : null);
  const [customer, setCustomer] = useState(fromDeal?.company ?? "");
  const [shipDate, setShipDate] = useState<Dayjs | null>(null);
  // Вилка отгрузки менеджера (09.10)
  const [shipWindow, setShipWindow] = useState<[Dayjs | null, Dayjs | null]>([null, fromDeal?.shipDate ? dayjs(fromDeal.shipDate) : null]);
  const { user: me } = useAuth();
  const isManager = hasPerm(me, "production_tasks.manage");
  const [preview, setPreview] = useState<{
    rows: ScheduleImportRow[];
    parse_errors: string[];
    colors?: ScheduleImportColor[];
    merges?: { invoice: string; order_id: number; order_invoice: string }[];
  } | null>(null);
  // Сопоставление цвет графика → плёнка: выбор сохраняется в привязку цвета
  // типа и дальше подставляется сам (в заданиях на ламинацию — эта плёнка).
  const [colorFilms, setColorFilms] = useState<Record<string, number>>({});
  // строка счёта → выбранная позиция, когда подходит несколько (21.10)
  const [itemChoices, setItemChoices] = useState<Record<string, number>>({});
  const choicesRef = useRef<Record<string, number>>({});
  const skusQuery = useQuery({ queryKey: ["material-skus", "active"], queryFn: () => listMaterialSkus(false), enabled: !!preview });
  const skuOptions = (skusQuery.data ?? [])
    .filter((s) => s.is_active && s.thickness.value_mm > 0)
    .map((s) => ({
      value: s.id,
      label: `${s.material.name} ${s.color.name} ${s.thickness.value_mm} мм · ${s.manufacturer.name}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));

  // Только что загруженный файл: разбор сразу, не дожидаясь перерисовки с новым текстом.
  const fromFile = useRef<{ text: string; invoiceNo: string } | null>(null);
  const run = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const src = fromFile.current ?? { text, invoiceNo };
      fromFile.current = null;
      if (forCustomer) {
        const r = await importCustomerOrders({
          text: src.text,
          type_id: sendType,
          invoice_no: src.invoiceNo.trim() || null,
          invoice_date: invoiceDate ? invoiceDate.format("YYYY-MM-DD") : null,
          customer: customer.trim() || null,
          ship_from: shipWindow[0] ? shipWindow[0].format("YYYY-MM-DD") : null,
          ship_to: shipWindow[1] ? shipWindow[1].format("YYYY-MM-DD") : null,
          dry_run: dryRun,
          color_films: colorFilms,
          item_choices: choicesRef.current,
          bitrix_deal_id: fromDeal?.id ?? null,
          bitrix_deal_title: fromDeal?.title ?? null,
          amount_rub: fromDeal?.amount ?? null,
          manager_bitrix_id: fromDeal?.assignedBx ?? null,
        });
        return { rows: r.rows, parse_errors: r.problems, colors: r.colors, order: null, created: r.created, updated: r.updated ?? [], merges: r.merges ?? [] };
      }
      return importOrderFromSchedule({
        text: src.text,
        type_id: sendType,
        name: name.trim() || null,
        dry_run: dryRun,
        color_films: colorFilms,
        item_choices: choicesRef.current,
        invoice_no: src.invoiceNo.trim() || null,
        ship_date: shipDate ? shipDate.format("YYYY-MM-DD") : null,
        ship_from: shipWindow[0] ? shipWindow[0].format("YYYY-MM-DD") : null,
        ship_to: shipWindow[1] ? shipWindow[1].format("YYYY-MM-DD") : null,
      }).then((r) => ({ ...r, created: [] as number[], updated: [] as number[], merges: [] }));
    },
    onSuccess: (res, dryRun) => {
      setPreview(res);
      if (!dryRun && forCustomer && (res.created.length || res.updated.length)) {
        qc.invalidateQueries({ queryKey: ["customer-orders"] });
        qc.invalidateQueries({ queryKey: ["customer-order"] });
        qc.invalidateQueries({ queryKey: ["items"] });
        message.success(
          [res.created.length ? `создано заказов: ${res.created.length}` : "", res.updated.length ? `дополнено: ${res.updated.length}` : ""]
            .filter(Boolean)
            .join(", ")
            .replace(/^./, (c) => c.toUpperCase()),
        );
        onCustomerCreated?.([...res.created, ...res.updated]);
      } else if (!dryRun && res.order) {
        qc.invalidateQueries({ queryKey: ["production-orders"] });
        qc.invalidateQueries({ queryKey: ["items"] });
        message.success(`Черновик заказа №${res.order.id} создан: ${res.order.lines.length} строк`);
        onCreated?.(res.order);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать график")),
  });
  // Файл счёта из 1С: номер счёта — имя файла, строки — в поле ниже, сразу разбор.
  const [fileProblems, setFileProblems] = useState<string[]>([]);
  const readFile = useMutation({
    mutationFn: readInvoiceFile,
    onSuccess: (r, f) => {
      // номер — из имени файла здесь: в заголовке запроса кириллица имени может прийти в чужой кодировке
      const inv = f.name.replace(/\.xlsx?$/i, "").replace(/\s+\(\d+\)$/, "").trim() || r.invoice_no;
      setInvoiceNo(inv);
      if (r.invoice_date) setInvoiceDate(dayjs(r.invoice_date));
      setText(r.text);
      setFileProblems(r.problems);
      setPreview(null);
      if (r.text && effectiveType != null) {
        fromFile.current = { text: r.text, invoiceNo: inv };
        run.mutate(true);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось прочитать файл счёта")),
  });
  const bad = preview ? preview.rows.filter((r) => r.errors.length > 0).length + preview.parse_errors.length : 0;
  const totalDoors = preview ? preview.rows.reduce((s, r) => s + r.qty, 0) : 0;
  const newItems = preview ? new Set(preview.rows.filter((r) => !r.exists && r.item_name).map((r) => r.item_name)).size : 0;

  return (
    <Modal
      open
      width={1100}
      title={forCustomer ? "Заказы клиентов из счёта 1С или графика" : "Заказ из графика запуска или счёта 1С"}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button disabled={!text.trim() || effectiveType == null} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
            Разобрать
          </Button>
          <Button
            type="primary"
            disabled={!preview || bad > 0 || preview.rows.length === 0}
            loading={run.isPending && run.variables === false}
            title={
              forCustomer
                ? "Заказ клиента на каждый счёт — черновиком; дальше отправить в производство"
                : "Создать черновик и открыть его страницу: там — настройка запуска (п/ф, площадки, сроки, раскладка по участкам)"
            }
            onClick={() => run.mutate(false)}
          >
            {forCustomer ? "Создать заказы клиентов" : "Создать черновик и перейти к запуску"}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {fromDeal && (
          <Alert
            type="info"
            showIcon
            message={`Заказ по сделке Битрикс24 №${fromDeal.id}: «${fromDeal.title}»`}
            description="Загрузите файл счёта 1С — позиции возьмутся из него. Сделка привяжется к заказу, сумма и менеджер — из сделки."
          />
        )}
        <Typography.Text type="secondary">
          Скопируйте строки графика из Excel и вставьте сюда. Колонки по порядку
          {selectedType ? `: ${importColumnsText(selectedType)}` : ""}. Свойства берутся из колонок и наименования по
          шаблону импорта типа («Номенклатура → Типы и правила»); изделия и их п/ф находятся или заводятся по правилам
          типа.
        </Typography.Text>
        <Space wrap>
          <Select
            style={{ width: 320 }}
            placeholder="Тип изделия"
            value={effectiveType}
            onChange={(v) => {
              setTypeId(v);
              setPreview(null);
            }}
            options={[
              ...(gpTypes.length > 1 ? [{ value: AUTO, label: `Все типы — по серии (${gpTypes.map((t) => t.name).join(", ")})` }] : []),
              ...gpTypes.map((t) => ({ value: t.id, label: t.name })),
            ]}
            popupMatchSelectWidth={false}
          />
          {forCustomer ? (
            <Input style={{ width: 360 }} placeholder="Клиент (как в счёте 1С)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          ) : (
            <Input style={{ width: 360 }} placeholder="Название заказа (по умолчанию — по дате отгрузки)" value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Space>
        <Space wrap>
          <Upload
            accept=".xls,.xlsx"
            showUploadList={false}
            beforeUpload={(f) => {
              readFile.mutate(f);
              return false;
            }}
          >
            <Button loading={readFile.isPending} title="Выгрузка счёта из 1С в Excel: колонки «Номенклатура» и «Количество», имя файла — номер счёта">
              Загрузить файл счёта 1С…
            </Button>
          </Upload>
          <Typography.Text type="secondary">или счёт целиком:</Typography.Text>
          <Input
            style={{ width: 180 }}
            placeholder="№ счёта"
            value={invoiceNo}
            onChange={(e) => {
              setInvoiceNo(e.target.value);
              setPreview(null);
            }}
          />
          {forCustomer && (
            <DatePicker placeholder="Дата счёта" format="DD.MM.YYYY" value={invoiceDate} onChange={setInvoiceDate} />
          )}
          {isManager && !forCustomer && (
            <DatePicker
              placeholder="Дата отгрузки"
              format="DD.MM.YYYY"
              value={shipDate}
              onChange={(v) => {
                setShipDate(v);
                setPreview(null);
              }}
            />
          )}
          <DatePicker.RangePicker
            placeholder={["Вилка отгрузки: с", "по"]}
            format="DD.MM.YYYY"
            allowEmpty={[true, false]}
            value={shipWindow}
            onChange={(v) => setShipWindow([v?.[0] ?? null, v?.[1] ?? null])}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            строки вида «В-15 (м9 кромка 4х) 600х2000 - Полипропилен Аляска …   30» — серия, размер и цвет берутся из наименования
          </Typography.Text>
        </Space>
        <Input.TextArea
          rows={6}
          value={text}
          placeholder="Вставьте строки графика или счёта из 1С…"
          style={{ fontFamily: "monospace", fontSize: 12 }}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
        />
        {fileProblems.map((p) => (
          <Typography.Text key={p} type="danger">
            {p}
          </Typography.Text>
        ))}
        {preview && (preview.colors ?? []).length > 0 && (
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              Цвета и плёнка
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              Цвет двери — это плёнка из справочника: текст из графика сопоставляется с плёнкой (как в заданиях на
              окутку) и запоминается как её синоним. Подобралась не та или не подобралась — выберите плёнку, выбор
              сохранится и пойдёт в задания на ламинацию.
            </Typography.Text>
            <Table<ScheduleImportColor>
              size="small"
              rowKey="color"
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={preview.colors}
              columns={[
                { title: "Цвет в графике", dataIndex: "color" },
                { title: "Строк", dataIndex: "rows", width: 70 },
                {
                  title: "Цвет двери (плёнка)",
                  render: (_, c) => (
                    <Space size={6} wrap>
                      {c.option && <Typography.Text strong>{c.option}</Typography.Text>}
                      <Tag color={COLOR_STATUS[c.status].color}>{COLOR_STATUS[c.status].text}</Tag>
                      {c.film && c.film !== c.option && <Typography.Text type="secondary">{c.film}</Typography.Text>}
                    </Space>
                  ),
                },
                {
                  title: "Выбрать плёнку",
                  width: 380,
                  render: (_, c) => (
                    <Select
                      showSearch
                      allowClear
                      size="small"
                      style={{ width: "100%" }}
                      placeholder={c.status === "ok" || c.status === "pet" ? "оставить как есть" : "выберите плёнку"}
                      loading={skusQuery.isLoading}
                      value={colorFilms[c.color]}
                      options={skuOptions}
                      optionFilterProp="label"
                      onChange={(v?: number) => {
                        const next = { ...colorFilms };
                        if (v == null) delete next[c.color];
                        else next[c.color] = v;
                        setColorFilms(next);
                      }}
                    />
                  ),
                },
              ]}
            />
            {Object.keys(colorFilms).length > 0 && (
              <Button size="small" style={{ marginTop: 8 }} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
                Разобрать заново с выбранной плёнкой
              </Button>
            )}
          </div>
        )}
        {preview && (
          <>
            {bad > 0 ? (
              <Alert
                type="error"
                showIcon
                message={
                  forCustomer
                    ? `Есть замечания: ${bad} — поправьте, заказы не создаются`
                    : `Строк с ошибками: ${bad} — поправьте в графике или настройке типа, заказ не создаётся`
                }
              />
            ) : (
              <Alert
                type="success"
                showIcon
                message={`Строк: ${preview.rows.length}, дверей: ${totalDoors}; новых позиций: ${newItems} — заведутся с техкартой по правилам типа`}
              />
            )}
            {(preview.merges ?? []).map((m) => (
              <Alert
                key={m.order_id}
                type="info"
                showIcon
                message={`Счёт ${m.invoice}: заказ №${m.order_id} (счёт ${m.order_invoice}) уже есть — дополнится новыми позициями, дата отгрузки станет новой`}
              />
            ))}
            {preview.parse_errors.map((e) => (
              <Typography.Text key={e} type="danger">
                {e}
              </Typography.Text>
            ))}
            <Table<ScheduleImportRow>
              size="small"
              rowKey={(_, i) => String(i)}
              pagination={{ pageSize: 50 }}
              scroll={{ y: 360, x: "max-content" }}
              dataSource={preview.rows}
              columns={[
                { title: "Счёт", dataIndex: "invoice_no" },
                ...(isAuto ? [{ title: "Тип", render: (_: unknown, r: ScheduleImportRow) => r.type_name ?? "—" }] : []),
                { title: "Серия", dataIndex: "series" },
                { title: "Размер", dataIndex: "size" },
                { title: "Цвет", dataIndex: "color" },
                {
                  // исполнение из строки счёта (26.10): в строку заказа, не в позицию
                  title: "Исполнение",
                  render: (_: unknown, r: ScheduleImportRow) => <LineOptions compact options={r.options} />,
                },
                { title: "Кол-во", dataIndex: "qty" },
                {
                  title: "Позиция",
                  render: (_, r) =>
                    (r.candidates ?? []).length > 0 ? (
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="warning">Подходит несколько — выберите (запомнится):</Typography.Text>
                        <Select
                          size="small"
                          style={{ width: 380 }}
                          placeholder="Какая позиция"
                          value={itemChoices[r.name_text]}
                          onChange={(v) => {
                            // один выбор — на все строки с теми же вариантами (одна коробка в разных декорах)
                            const sig = (x: ScheduleImportRow) => (x.candidates ?? []).map((c) => c.id).join(",");
                            const same = (preview?.rows ?? []).filter((x) => sig(x) && sig(x) === sig(r)).map((x) => x.name_text);
                            choicesRef.current = { ...choicesRef.current, ...Object.fromEntries([r.name_text, ...same].map((n) => [n, v])) };
                            setItemChoices(choicesRef.current);
                            run.mutate(true);
                          }}
                          options={(r.candidates ?? []).map((c) => ({ value: c.id, label: c.name }))}
                        />
                      </Space>
                    ) : r.errors.length > 0 ? (
                      <Typography.Text type="danger">{r.errors.join("; ")}</Typography.Text>
                    ) : (
                      <Space size={4} wrap>
                        <span>{r.item_name}</span>
                        {r.exists ? <Tag>есть</Tag> : <Tag color="green">новая</Tag>}
                        {(r.notes ?? []).map((n) => (
                          <Tag key={n} color={n.includes("не найдена") ? "orange" : "blue"}>
                            {n}
                          </Tag>
                        ))}
                      </Space>
                    ),
                },
                {
                  title: "Наименование в графике",
                  render: (_, r) => (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.name_text}
                    </Typography.Text>
                  ),
                },
              ]}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}
