import { useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listItemTypes } from "../../../api/itemTypes";
import { listMaterialSkus } from "../../../api/dictionaries";
import { importColumnsText } from "../nomenclature/ImportTemplateModal";
import ReleaseLayoutModal from "./ReleaseLayoutModal";
import {
  EMPTY_PLAN,
  getScheduleLayout,
  importOrderFromSchedule,
  type ProductionOrder,
  type ScheduleImportColor,
  type ScheduleImportRow,
} from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

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
export default function ScheduleImportModal({ onClose, onCreated }: { onClose: () => void; onCreated: (o: ProductionOrder) => void }) {
  const qc = useQueryClient();
  const typesQuery = useQuery({ queryKey: ["item-types"], queryFn: () => listItemTypes() });
  // Типы с шаблоном импорта (колонки графика и признаки — настройка типа).
  const gpTypes = (typesQuery.data ?? []).filter((t) => t.kind_code === "izdelie" && t.is_active && t.name_template && t.import_template);
  const [typeId, setTypeId] = useState<number | undefined>();
  const effectiveType = typeId ?? gpTypes[0]?.id;
  const selectedType = gpTypes.find((t) => t.id === effectiveType);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ rows: ScheduleImportRow[]; parse_errors: string[]; colors?: ScheduleImportColor[] } | null>(null);
  // Сопоставление цвет графика → плёнка: выбор сохраняется в привязку цвета
  // типа и дальше подставляется сам (в заданиях на ламинацию — эта плёнка).
  const [colorFilms, setColorFilms] = useState<Record<string, number>>({});
  const [layoutOpen, setLayoutOpen] = useState(false);
  const skusQuery = useQuery({ queryKey: ["material-skus", "active"], queryFn: () => listMaterialSkus(false), enabled: !!preview });
  const skuOptions = (skusQuery.data ?? [])
    .filter((s) => s.is_active && s.thickness.value_mm > 0)
    .map((s) => ({
      value: s.id,
      label: `${s.material.name} ${s.color.name} ${s.thickness.value_mm} мм · ${s.manufacturer.name}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      importOrderFromSchedule({
        text,
        type_id: effectiveType as number,
        name: name.trim() || null,
        dry_run: dryRun,
        color_films: colorFilms,
      }),
    onSuccess: (res, dryRun) => {
      setPreview(res);
      if (!dryRun && res.order) {
        qc.invalidateQueries({ queryKey: ["production-orders"] });
        qc.invalidateQueries({ queryKey: ["items"] });
        message.success(`Черновик заказа №${res.order.id} создан: ${res.order.lines.length} строк`);
        onCreated(res.order);
      }
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать график")),
  });
  const bad = preview ? preview.rows.filter((r) => r.errors.length > 0).length + preview.parse_errors.length : 0;
  const totalDoors = preview ? preview.rows.reduce((s, r) => s + r.qty, 0) : 0;
  const newItems = preview ? new Set(preview.rows.filter((r) => !r.exists && r.item_name).map((r) => r.item_name)).size : 0;

  return (
    <Modal
      open
      width={1100}
      title="Заказ из графика запуска"
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button disabled={!text.trim() || !effectiveType} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
            Разобрать
          </Button>
          <Button
            disabled={!preview || bad > 0 || preview.rows.length === 0}
            title="Что родится по участкам — как листы Excel-монитора; ничего не создаётся"
            onClick={() => setLayoutOpen(true)}
          >
            Раскладка по участкам
          </Button>
          <Button
            type="primary"
            disabled={!preview || bad > 0 || preview.rows.length === 0}
            loading={run.isPending && run.variables === false}
            onClick={() => run.mutate(false)}
          >
            Создать черновик заказа
          </Button>
        </Space>
      }
    >
      {layoutOpen && effectiveType && (
        <ReleaseLayoutModal
          order={{ id: 0, name: name.trim() || "по графику" } as ProductionOrder}
          picks={[]}
          overrides={{}}
          onOverridesChange={() => {}}
          plan={EMPTY_PLAN}
          onPlanChange={() => {}}
          onClose={() => setLayoutOpen(false)}
          preview={{
            title: `Раскладка по участкам — ${name.trim() || "график"} (предпросмотр)`,
            load: () => getScheduleLayout({ text, type_id: effectiveType, color_films: colorFilms }),
          }}
        />
      )}
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Скопируйте строки графика из Excel и вставьте сюда. Колонки по порядку
          {selectedType ? `: ${importColumnsText(selectedType)}` : ""}. Свойства берутся из колонок и наименования по
          шаблону импорта типа («Номенклатура → Типы и правила»); изделия и их п/ф находятся или заводятся по правилам
          типа.
        </Typography.Text>
        <Space wrap>
          <Select
            style={{ width: 240 }}
            placeholder="Тип изделия"
            value={effectiveType}
            onChange={(v) => {
              setTypeId(v);
              setPreview(null);
            }}
            options={gpTypes.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Input style={{ width: 360 }} placeholder="Название заказа (по умолчанию — по дате отгрузки)" value={name} onChange={(e) => setName(e.target.value)} />
        </Space>
        <Input.TextArea
          rows={6}
          value={text}
          placeholder="Вставьте строки графика…"
          style={{ fontFamily: "monospace", fontSize: 12 }}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
        />
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
              <Alert type="error" showIcon message={`Строк с ошибками: ${bad} — поправьте в графике или настройке типа, заказ не создаётся`} />
            ) : (
              <Alert
                type="success"
                showIcon
                message={`Строк: ${preview.rows.length}, дверей: ${totalDoors}; новых позиций: ${newItems} — заведутся с техкартой по правилам типа`}
              />
            )}
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
                { title: "Серия", dataIndex: "series" },
                { title: "Размер", dataIndex: "size" },
                { title: "Цвет", dataIndex: "color" },
                { title: "Кол-во", dataIndex: "qty" },
                {
                  title: "Позиция",
                  render: (_, r) =>
                    r.errors.length > 0 ? (
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
