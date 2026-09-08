import { useRef, useState } from "react";
import { Card, Space, Typography, Select, InputNumber, Input, Button, message, Empty, Popconfirm, Modal, List, Tag, Form } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { listProductionTasks, createTaskLineReport, type ProductionTask, type ProductionTaskLine } from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { listPartUnits } from "../../../api/partUnits";
import { listParts } from "../../../api/dictionaries";

interface DefectEntry {
  reason: string;
  qty: number;
  note?: string;
}

interface ReportRow {
  key: string;
  taskId: number;
  line: ProductionTaskLine;
  materialUnitId: number | null;
  partUnitId: number | null;
  goodPieces: number;
  // Раздел про несколько причин брака в одном отчёте — раньше был один
  // defectPieces + одна defectReason на всю строку, хотя по факту разные
  // штуки брака в одной партии часто идут по разным причинам (мусор под
  // плёнкой, царапина, скол и т.п.). Список записей вместо одной пары —
  // тот же приём, что уже есть в ReportModal.tsx (defectRows).
  defects: DefectEntry[];
}

const totalDefect = (row: ReportRow) => row.defects.reduce((sum, d) => sum + d.qty, 0);

/** Быстрый отчёт мастера без распределения по дням (участок с
 * Area.requires_daily_plan=false, пилот: окутка царговых) — раньше
 * приходилось открывать отдельную модалку "Отчитаться о производстве"
 * на КАЖДОЙ строке задания по одной (неудобно при десятке позиций за
 * смену). Здесь одним поиском набирается сразу список нужных позиций,
 * заполняется инлайн в таблице и сохраняется всё одним нажатием — один
 * отчёт по всем позициям, а не N отдельных модалок.
 *
 * Раздел про поиск позиции на планшете — раньше строкой ввода служил
 * обычный antd Select(showSearch): выпадающий список позиционируется
 * относительно поля через портал, и в горизонтальной ориентации (где и
 * так мало высоты) экранная клавиатура выталкивала список наполовину за
 * пределы видимой области. Модалка с обычным текстовым полем + плоским
 * List ниже не зависит от такого позиционирования — оба всегда в одном
 * скролл-контейнере модалки, клавиатура может занять сколько угодно
 * места снизу, список просто ужмётся, но останется на экране целиком. */
export default function MasterQuickReportPanel({ area }: { area: string }) {
  const qc = useQueryClient();
  const requiresRoll = area === "okutka_tsargovykh";
  // Раздел про связь этапов с участками — «Партия п/ф» показывается для
  // ЛЮБОГО участка, у которого есть хоть один этап детали (не только у
  // окутки царговых): «Рулон» — отдельная, чисто плёночная забота.
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const hasPartStages = (partsQuery.data ?? []).some((p) => p.stages.some((s) => s.area === area));
  const [rows, setRows] = useState<ReportRow[]>([]);
  const rowCounter = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [defectRowKey, setDefectRowKey] = useState<string | null>(null);
  const [defectForm] = Form.useForm<{ reason: string; qty: number; note?: string }>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "production"], queryFn: () => listWriteOffReasons("production") });
  // Раздел про физический учёт деталей — причина брака та же, что
  // списывает и партию п/ф, пикер объединяет обе категории причин.
  const partsReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "parts"],
    queryFn: () => listWriteOffReasons("parts"),
    enabled: hasPartStages,
  });
  const reasonOptions = [...(writeOffReasonsQuery.data ?? []), ...(partsReasonsQuery.data ?? [])].filter(
    (r, i, arr) => arr.findIndex((x) => x.code === r.code) === i,
  );
  const reasonName = (code: string) => reasonOptions.find((r) => r.code === code)?.name ?? code;
  const partUnitsQuery = useQuery({
    queryKey: ["part-units", "area", area],
    queryFn: () => listPartUnits({ area, status_: "Выдан_участку" }),
    enabled: hasPartStages,
  });
  // Раздел про связь этапов с участками — партия п/ф путешествует между
  // РАЗНЫМИ заданиями (у каждого участка своё), поэтому её
  // production_task_line_id остаётся указывать на задание, где она
  // родилась, а не на текущее: подбор партии под конкретную строку — по
  // совпадению названия детали, не по id строки.
  const partUnitOptionsForLine = (line: ProductionTaskLine) =>
    line.part_name ? (partUnitsQuery.data ?? []).filter((u) => u.part_name === line.part_name) : [];

  const tasks = (tasksQuery.data ?? []).filter((t: ProductionTask) => t.area === area && t.is_active);
  const addedLineIds = new Set(rows.map((r) => r.line.id));

  const positionOptions = tasks.flatMap((task) =>
    task.lines.map((line) => ({
      key: `${task.id}:${line.id}`,
      taskId: task.id,
      line,
      label: `${task.product_model_name ?? task.name ?? `Задание №${task.id}`} — ${line.part_name ?? line.material} (${line.material}, ${line.color}, ${line.thickness} мм) — осталось ${line.remaining_pieces} шт`,
      added: addedLineIds.has(line.id),
    })),
  );
  const filteredPositionOptions = pickerSearch.trim()
    ? positionOptions.filter((o) => o.label.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
    : positionOptions;

  const addRow = (taskId: number, line: ProductionTaskLine) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    rowCounter.current += 1;
    const availableParts = partUnitOptionsForLine(line);
    setRows((prev) => [
      ...prev,
      {
        key: `${line.id}-${rowCounter.current}`,
        taskId: task.id,
        line,
        materialUnitId: line.issued_units.length === 1 ? line.issued_units[0].id : null,
        partUnitId: availableParts.length === 1 ? availableParts[0].id : null,
        goodPieces: 0,
        defects: [],
      },
    ]);
    setPickerOpen(false);
    setPickerSearch("");
  };

  const updateRow = (key: string, patch: Partial<ReportRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

  const addDefectEntry = (key: string, entry: DefectEntry) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, defects: [...r.defects, entry] } : r)));
  const removeDefectEntry = (key: string, index: number) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, defects: r.defects.filter((_, i) => i !== index) } : r)));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const calls: Promise<unknown>[] = [];
      for (const r of rows) {
        if (r.goodPieces > 0) {
          calls.push(
            createTaskLineReport(r.taskId, r.line.id, {
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              part_unit_id: r.partUnitId,
              good_pieces: r.goodPieces,
              defect_pieces: 0,
            }),
          );
        }
        for (const d of r.defects) {
          calls.push(
            createTaskLineReport(r.taskId, r.line.id, {
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              part_unit_id: r.partUnitId,
              good_pieces: 0,
              defect_pieces: d.qty,
              defect_reason: d.reason,
              note: d.note,
            }),
          );
        }
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success(`Отчёт по ${rows.length} ${rows.length === 1 ? "позиции" : "позициям"} сохранён`);
      setRows([]);
    },
    onError: () => message.error("Не удалось сохранить отчёт — проверьте позиции с ошибками"),
  });

  const handleSave = () => {
    if (rows.length === 0) {
      message.warning("Добавьте хотя бы одну позицию");
      return;
    }
    for (const r of rows) {
      if (r.goodPieces <= 0 && totalDefect(r) <= 0) {
        message.warning(`Укажите хорошие детали или брак по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
      if (requiresRoll && !r.materialUnitId) {
        message.warning(`Выберите рулон по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
    }
    saveMutation.mutate();
  };

  const defectRow = rows.find((r) => r.key === defectRowKey) ?? null;

  return (
    <Card title="📋 Отчёт о производстве">
      <Typography.Paragraph type="secondary">
        Найдите нужные детали через поиск ниже — каждая добавится отдельной строкой в отчёт. Заполните количество и
        сохраните всё одним нажатием.
      </Typography.Paragraph>
      <Button block size="large" onClick={() => setPickerOpen(true)}>
        🔍 Добавить позицию…
      </Button>

      <Modal
        title="Найти позицию"
        open={pickerOpen}
        onCancel={() => {
          setPickerOpen(false);
          setPickerSearch("");
        }}
        footer={null}
        destroyOnHidden
      >
        <Input.Search
          autoFocus
          allowClear
          placeholder="Название детали или задания…"
          value={pickerSearch}
          onChange={(e) => setPickerSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {tasksQuery.isLoading ? (
          <Typography.Text type="secondary">Загрузка…</Typography.Text>
        ) : filteredPositionOptions.length === 0 ? (
          <Typography.Text type="secondary">
            {positionOptions.length === 0 ? "Нет активных заданий для вашего участка" : "Ничего не найдено"}
          </Typography.Text>
        ) : (
          <List
            style={{ maxHeight: "50vh", overflowY: "auto" }}
            dataSource={filteredPositionOptions}
            renderItem={(o) => (
              <List.Item
                onClick={() => !o.added && addRow(o.taskId, o.line)}
                style={{ cursor: o.added ? "default" : "pointer", opacity: o.added ? 0.55 : 1 }}
              >
                <List.Item.Meta title={o.label} description={o.added ? "✓ уже добавлено" : undefined} />
              </List.Item>
            )}
          />
        )}
      </Modal>

      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока ни одна позиция не добавлена" style={{ marginTop: 16 }} />
      ) : (
        <>
          <ResponsiveTable<ReportRow>
            tableKey="master-quick-report"
            lockedColumns={["remove"]}
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={rows}
            scroll={{ x: "max-content" }}
            style={{ marginTop: 16, marginBottom: 16 }}
            columns={[
              {
                title: "Деталь",
                key: "part",
                render: (_, r) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{r.line.part_name ?? r.line.material}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.line.material}, {r.line.color}, {r.line.thickness} мм — произведено {r.line.produced_good_pieces} из{" "}
                      {r.line.quantity_pieces} шт
                    </Typography.Text>
                  </Space>
                ),
              },
              ...(requiresRoll
                ? [
                    {
                      title: "Рулон (№ штрипса)",
                      key: "roll",
                      render: (_: unknown, r: ReportRow) => (
                        <Select
                          size="small"
                          style={{ width: 190 }}
                          placeholder="Выберите рулон"
                          value={r.materialUnitId ?? undefined}
                          onChange={(v) => updateRow(r.key, { materialUnitId: v })}
                          options={r.line.issued_units.map((u) => ({ value: u.id, label: `№${u.id} — ${u.width_mm}×${u.length_m} м` }))}
                          notFoundContent={<Typography.Text type="secondary">Рулон не выдан</Typography.Text>}
                        />
                      ),
                    },
                  ]
                : []),
              ...(hasPartStages
                ? [
                    {
                      title: "Партия п/ф (опционально)",
                      key: "partUnit",
                      render: (_: unknown, r: ReportRow) => (
                        <Select
                          allowClear
                          size="small"
                          style={{ width: 200 }}
                          placeholder="Без партии"
                          value={r.partUnitId ?? undefined}
                          onChange={(v) => updateRow(r.key, { partUnitId: v ?? null })}
                          options={partUnitOptionsForLine(r.line).map((u) => ({
                            value: u.id,
                            label: `№${u.id} — ${u.quantity_pieces} шт, «${u.stage_name}»`,
                          }))}
                          notFoundContent={<Typography.Text type="secondary">Партия не выдана — «Учёт п/ф»</Typography.Text>}
                        />
                      ),
                    },
                  ]
                : []),
              {
                title: "Хорошие, шт",
                key: "good",
                render: (_, r) => (
                  <InputNumber size="small" min={0} style={{ width: 90 }} value={r.goodPieces} onChange={(v) => updateRow(r.key, { goodPieces: v ?? 0 })} />
                ),
              },
              {
                title: "Брак",
                key: "defect",
                render: (_, r) => (
                  <Space direction="vertical" size={4}>
                    {r.defects.map((d, i) => (
                      <Tag key={i} closable onClose={() => removeDefectEntry(r.key, i)} style={{ marginRight: 0 }}>
                        {reasonName(d.reason)}: {d.qty} шт
                      </Tag>
                    ))}
                    <Button
                      size="small"
                      onClick={() => {
                        // Раздел про несколько причин брака — форма одна на все
                        // строки (defectForm), не размонтируется между открытиями
                        // (destroyOnHidden чистит только DOM модалки, не сам
                        // Form.useForm store) — без явного сброса недописанный
                        // черновик причины по одной строке подставлялся бы при
                        // открытии для другой.
                        defectForm.resetFields();
                        setDefectRowKey(r.key);
                      }}
                    >
                      {r.defects.length > 0 ? `+ ещё причина (всего ${totalDefect(r)} шт)` : "+ указать брак"}
                    </Button>
                  </Space>
                ),
              },
              {
                title: "",
                key: "remove",
                render: (_, r) => (
                  <Popconfirm title="Убрать эту позицию из отчёта?" onConfirm={() => removeRow(r.key)}>
                    <Button size="small" danger>
                      Убрать
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
          <Button type="primary" block loading={saveMutation.isPending} onClick={handleSave}>
            Сохранить отчёт ({rows.length} {rows.length === 1 ? "позиция" : "позиций"})
          </Button>
        </>
      )}

      <Modal
        title={`Брак — «${defectRow?.line.part_name ?? defectRow?.line.material ?? ""}»`}
        open={!!defectRow}
        onCancel={() => setDefectRowKey(null)}
        footer={null}
        destroyOnHidden
      >
        {defectRow && (
          <>
            {defectRow.defects.length > 0 && (
              <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
                {defectRow.defects.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>
                      {reasonName(d.reason)}: <strong>{d.qty} шт</strong>
                      {d.note && <Typography.Text type="secondary"> — {d.note}</Typography.Text>}
                    </span>
                    <Button size="small" danger onClick={() => removeDefectEntry(defectRow.key, i)}>
                      Убрать
                    </Button>
                  </div>
                ))}
              </Space>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
              Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь царапины:
              добавьте отдельную запись на каждую причину.
            </Typography.Paragraph>
            <Form
              form={defectForm}
              layout="vertical"
              onFinish={(v) => {
                addDefectEntry(defectRow.key, v);
                defectForm.resetFields();
              }}
            >
              <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
                <Select
                  loading={writeOffReasonsQuery.isLoading || partsReasonsQuery.isLoading}
                  options={reasonOptions.map((r) => ({ value: r.code, label: r.name }))}
                />
              </Form.Item>
              <Form.Item name="qty" label="Количество, шт" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item name="note" label="Заметка (опционально)">
                <Input placeholder="Например: мусор под плёнкой" />
              </Form.Item>
              <Button htmlType="submit" block>
                Добавить причину
              </Button>
            </Form>
            <Button block type="primary" style={{ marginTop: 16 }} onClick={() => setDefectRowKey(null)}>
              Готово
            </Button>
          </>
        )}
      </Modal>
    </Card>
  );
}
