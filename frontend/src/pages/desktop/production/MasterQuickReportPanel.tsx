import { useRef, useState } from "react";
import { Card, Space, Typography, Select, Table, InputNumber, Button, message, Empty, Popconfirm } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProductionTasks, createTaskLineReport, type ProductionTask, type ProductionTaskLine } from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { listPartUnits } from "../../../api/partUnits";

interface ReportRow {
  key: string;
  taskId: number;
  line: ProductionTaskLine;
  materialUnitId: number | null;
  partUnitId: number | null;
  goodPieces: number;
  defectPieces: number;
  defectReason: string | null;
}

/** Быстрый отчёт мастера без распределения по дням (участок с
 * Area.requires_daily_plan=false, пилот: окутка царговых) — раньше
 * приходилось открывать отдельную модалку "Отчитаться о производстве"
 * на КАЖДОЙ строке задания по одной (неудобно при десятке позиций за
 * смену). Здесь одним поиском в select набирается сразу список нужных
 * позиций, заполняется инлайн в таблице и сохраняется всё одним
 * нажатием — один отчёт по всем позициям, а не N отдельных модалок. */
export default function MasterQuickReportPanel({ area }: { area: string }) {
  const qc = useQueryClient();
  const requiresRoll = area === "okutka_tsargovykh";
  const [rows, setRows] = useState<ReportRow[]>([]);
  const rowCounter = useRef(0);

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "production"], queryFn: () => listWriteOffReasons("production") });
  // Раздел про физический учёт деталей — причина брака та же, что
  // списывает и партию п/ф, пикер объединяет обе категории причин.
  const partsReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "parts"],
    queryFn: () => listWriteOffReasons("parts"),
    enabled: requiresRoll,
  });
  const reasonOptions = [...(writeOffReasonsQuery.data ?? []), ...(partsReasonsQuery.data ?? [])].filter(
    (r, i, arr) => arr.findIndex((x) => x.code === r.code) === i,
  );
  const partUnitsQuery = useQuery({
    queryKey: ["part-units", "area", area],
    queryFn: () => listPartUnits({ area, status_: "Выдан_участку" }),
    enabled: requiresRoll,
  });
  const partUnitOptionsForLine = (lineId: number) =>
    (partUnitsQuery.data ?? []).filter((u) => u.production_task_line_id === lineId);

  const tasks = (tasksQuery.data ?? []).filter((t: ProductionTask) => t.area === area && t.is_active);
  const addedLineIds = new Set(rows.map((r) => r.line.id));

  const positionOptions = tasks.flatMap((task) =>
    task.lines.map((line) => ({
      value: `${task.id}:${line.id}`,
      label: `${task.product_model_name ?? task.name ?? `Задание №${task.id}`} — ${line.part_name ?? line.material} (${line.material}, ${line.color}, ${line.thickness} мм) — осталось ${line.remaining_pieces} шт${addedLineIds.has(line.id) ? " ✓ уже добавлено" : ""}`,
    })),
  );

  const addRow = (value: string) => {
    const [taskIdStr, lineIdStr] = value.split(":");
    const taskId = Number(taskIdStr);
    const task = tasks.find((t) => t.id === taskId);
    const line = task?.lines.find((l) => l.id === Number(lineIdStr));
    if (!task || !line) return;
    rowCounter.current += 1;
    const availableParts = partUnitOptionsForLine(line.id);
    setRows((prev) => [
      ...prev,
      {
        key: `${line.id}-${rowCounter.current}`,
        taskId: task.id,
        line,
        materialUnitId: line.issued_units.length === 1 ? line.issued_units[0].id : null,
        partUnitId: availableParts.length === 1 ? availableParts[0].id : null,
        goodPieces: 0,
        defectPieces: 0,
        defectReason: null,
      },
    ]);
  };

  const updateRow = (key: string, patch: Partial<ReportRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

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
        if (r.defectPieces > 0) {
          calls.push(
            createTaskLineReport(r.taskId, r.line.id, {
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              part_unit_id: r.partUnitId,
              good_pieces: 0,
              defect_pieces: r.defectPieces,
              defect_reason: r.defectReason ?? undefined,
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
      if (r.goodPieces <= 0 && r.defectPieces <= 0) {
        message.warning(`Укажите хорошие детали или брак по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
      if (requiresRoll && !r.materialUnitId) {
        message.warning(`Выберите рулон по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
      if (r.defectPieces > 0 && !r.defectReason) {
        message.warning(`Укажите причину брака по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
    }
    saveMutation.mutate();
  };

  return (
    <Card title="📋 Отчёт о производстве">
      <Typography.Paragraph type="secondary">
        Найдите нужные детали через поиск ниже — каждая добавится отдельной строкой в отчёт. Заполните количество и
        сохраните всё одним нажатием.
      </Typography.Paragraph>
      <Select
        showSearch
        value={null}
        placeholder="Начните вводить название детали или задания…"
        style={{ width: "100%", marginBottom: 16 }}
        filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
        options={positionOptions}
        onChange={(v) => v && addRow(v)}
        loading={tasksQuery.isLoading}
        notFoundContent={<Typography.Text type="secondary">Нет активных заданий для вашего участка</Typography.Text>}
      />

      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока ни одна позиция не добавлена" />
      ) : (
        <>
          <Table
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={rows}
            scroll={{ x: "max-content" }}
            style={{ marginBottom: 16 }}
            columns={[
              {
                title: "Деталь",
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
                    {
                      title: "Партия п/ф (опционально)",
                      render: (_: unknown, r: ReportRow) => (
                        <Select
                          allowClear
                          size="small"
                          style={{ width: 200 }}
                          placeholder="Без партии"
                          value={r.partUnitId ?? undefined}
                          onChange={(v) => updateRow(r.key, { partUnitId: v ?? null })}
                          options={partUnitOptionsForLine(r.line.id).map((u) => ({
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
                render: (_, r) => (
                  <InputNumber size="small" min={0} style={{ width: 90 }} value={r.goodPieces} onChange={(v) => updateRow(r.key, { goodPieces: v ?? 0 })} />
                ),
              },
              {
                title: "Брак, шт",
                render: (_, r) => (
                  <InputNumber size="small" min={0} style={{ width: 90 }} value={r.defectPieces} onChange={(v) => updateRow(r.key, { defectPieces: v ?? 0 })} />
                ),
              },
              {
                title: "Причина брака",
                render: (_, r) =>
                  r.defectPieces > 0 && (
                    <Select
                      size="small"
                      style={{ width: 170 }}
                      placeholder="Причина"
                      loading={writeOffReasonsQuery.isLoading || partsReasonsQuery.isLoading}
                      value={r.defectReason ?? undefined}
                      onChange={(v) => updateRow(r.key, { defectReason: v })}
                      options={reasonOptions.map((wr) => ({ value: wr.code, label: wr.name }))}
                    />
                  ),
              },
              {
                title: "",
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
    </Card>
  );
}
