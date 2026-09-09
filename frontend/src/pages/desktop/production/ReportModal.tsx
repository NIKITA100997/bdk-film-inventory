import { useEffect, useState } from "react";
import { Modal, Form, Select, InputNumber, Input, Button, Table, Typography, message, Space, Tag } from "antd";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTaskLineReport, type ProductionTaskLine } from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { listPartUnits } from "../../../api/partUnits";

/** Отчёт о производстве/браке (раздел про брак по дням) — отчёт обычно
 * привязан к конкретной записи распределения (день/линия/сотрудники), не
 * к строке задания целиком, поэтому используется и из общего списка
 * заданий (мастер сам выбирает распределение из списка строки), и из
 * «Плана на день» (распределение уже известно — presetAssignmentId).
 * Раздел про отключение распределения по дням — участок с
 * Area.requires_daily_plan=false (requiresDailyPlan=false здесь) вообще
 * не создаёт распределений, так что выбор становится необязательным и
 * отчёт уходит с assignment_id=null (бэкенд это для таких участков
 * разрешает, см. create_task_line_report). */
export default function ReportModal({
  taskId,
  line,
  presetAssignmentId,
  requiresDailyPlan = true,
  requiresRoll = false,
  onClose,
}: {
  taskId: number;
  line: ProductionTaskLine;
  presetAssignmentId?: number;
  requiresDailyPlan?: boolean;
  requiresRoll?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Раздел про учёт п/ф по FIFO — партия для готовых деталей больше не
  // выбирается (расходуется автоматически от самой старой по дате
  // изготовления), но брак физически обнаруживается в конкретной
  // партии — выбор остаётся ручным, per-запись брака (part_unit_id
  // здесь, не на общей форме).
  const [defectRows, setDefectRows] = useState<{ reason: string; qty: number; note?: string; part_unit_id: number | null }[]>([]);
  // Раздел про второй рулон на ту же строку — окутка в 2 захода часто
  // тратит НЕСКОЛЬКО разных рулонов на одну деталь (закончился на
  // стороне 1, начат новый на стороне 2) — оба нужно отметить
  // использованными в одном отчёте по строке, не только material_unit_id
  // выше. qty — сколько ГОТОВЫХ деталей физически получилось именно из
  // этого рулона (не из "основного"): расход конкретного рулона
  // (_unit_consumed_length_m) считается по отчётам, ссылающимся именно
  // на его material_unit_id, так что без разбивки весь расход задним
  // числом приписался бы только "основному" рулону, а остальные
  // выглядели бы нетронутыми при возврате. qty=0 — рулон тоже
  // использован, просто отдельный "нулевой" отчёт.
  const [extraRolls, setExtraRolls] = useState<{ materialUnitId: number; qty: number }[]>([]);
  const [reportForm] = Form.useForm<{
    assignment_id: number | null;
    material_unit_id: number | null;
    good_pieces: number;
  }>();
  const [defectRowForm] = Form.useForm<{ reason: string; qty: number; note?: string; part_unit_id?: number }>();
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
  });
  // Раздел про физический учёт деталей — причина брака этого отчёта та же,
  // что списывает и партию п/ф (одна проблема — один код), поэтому пикер
  // объединяет обычные причины брака производства с причинами деталей.
  const partsReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "parts"],
    queryFn: () => listWriteOffReasons("parts"),
    enabled: requiresRoll,
  });
  const reasonOptions = [...(writeOffReasonsQuery.data ?? []), ...(partsReasonsQuery.data ?? [])].filter(
    (r, i, arr) => arr.findIndex((x) => x.code === r.code) === i,
  );
  const reasonName = (code: string) => reasonOptions.find((r) => r.code === code)?.name ?? code;

  const partUnitsQuery = useQuery({
    queryKey: ["part-units", "line", line.id],
    queryFn: () => listPartUnits({ production_task_line_id: line.id, status_: "Выдан_участку" }),
    enabled: requiresRoll,
  });
  // Автовыбор партии при единственном варианте — приходит асинхронно
  // (в отличие от line.issued_units, уже готовых в пропе), initialValues
  // формы этого не подхватит сам по себе. Раздел про учёт п/ф по FIFO —
  // теперь только для формы брака (defectRowForm), не общей формы.
  useEffect(() => {
    if (partUnitsQuery.data?.length === 1 && defectRowForm.getFieldValue("part_unit_id") == null) {
      defectRowForm.setFieldValue("part_unit_id", partUnitsQuery.data[0].id);
    }
  }, [partUnitsQuery.data, defectRowForm]);

  const addDefectRow = (v: { reason: string; qty: number; note?: string; part_unit_id?: number }) => {
    setDefectRows((rows) => [...rows, { ...v, part_unit_id: v.part_unit_id ?? null }]);
    defectRowForm.resetFields();
  };
  const removeDefectRow = (index: number) => setDefectRows((rows) => rows.filter((_, i) => i !== index));

  const reportMutation = useMutation({
    // Раздел про несколько причин брака в одном отчёте — накопительный
    // журнал (ProductionTaskLineReport) уже это поддерживает: просто шлём
    // несколько строк вместо одной (хорошие детали отдельной строкой,
    // затем по одной строке на каждую причину брака), агрегаты суммируют
    // их на бэкенде так же, как если бы это были отчёты за разные смены.
    mutationFn: async (v: {
      assignment_id: number | null;
      material_unit_id: number | null;
      good_pieces: number;
    }) => {
      const calls: Promise<unknown>[] = [];
      if (v.good_pieces > 0) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            material_unit_id: v.material_unit_id,
            good_pieces: v.good_pieces,
            defect_pieces: 0,
          }),
        );
      }
      for (const row of defectRows) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            material_unit_id: v.material_unit_id,
            part_unit_id: row.part_unit_id,
            good_pieces: 0,
            defect_pieces: row.qty,
            defect_reason: row.reason,
            note: row.note,
          }),
        );
      }
      // Раздел про расход плёнки без готовой детали (окутка в 2 захода) —
      // ни хороших, ни брака ещё нет (деталь физически не готова), но
      // рулон уже трогали — отдельный "нулевой" отчёт: не засчитывается в
      // остаток задания, но фиксирует факт использования рулона, чтобы
      // его потом можно было вернуть/списать (see has_report в return_unit).
      if (requiresRoll && v.good_pieces <= 0 && defectRows.length === 0 && v.material_unit_id) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            material_unit_id: v.material_unit_id,
            good_pieces: 0,
            defect_pieces: 0,
            note: "Рулон использован, деталь ещё не готова",
          }),
        );
      }
      // Раздел про второй рулон на ту же строку — независимо от того,
      // что происходит с "основным" рулоном/хорошими/браком выше, каждый
      // дополнительный рулон отправляет свой отдельный отчёт: с qty>0 —
      // столько готовых деталей физически получилось именно из НЕГО
      // (расход по этому рулону посчитается верно при возврате), с
      // qty=0 — "нулевой" отчёт (рулон тоже использован, просто не
      // добавил новых деталей сверх уже посчитанного).
      for (const extra of extraRolls) {
        calls.push(
          createTaskLineReport(taskId, line.id, {
            assignment_id: v.assignment_id,
            material_unit_id: extra.materialUnitId,
            good_pieces: extra.qty,
            defect_pieces: 0,
            ...(extra.qty <= 0 ? { note: "Рулон использован" } : {}),
          }),
        );
      }
      await Promise.all(calls);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Отчёт сохранён");
      onClose();
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  const primaryRollId = Form.useWatch("material_unit_id", reportForm) as number | null | undefined;
  const extraRollIds = new Set(extraRolls.map((e) => e.materialUnitId));
  const extraRollOptions = line.issued_units.filter((u) => u.id !== primaryRollId && !extraRollIds.has(u.id));

  return (
    <Modal title={`Отчёт по линии «${line.part_name ?? line.line_name}»`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Нужно: {line.quantity_pieces} шт, уже произведено: {line.produced_good_pieces} шт, остаток: {line.remaining_pieces} шт.
        {requiresRoll && (
          <>
            {" "}Партия п/ф для готовых деталей теперь не выбирается — списывается автоматически от самой старой по
            дате изготовления («Учёт п/ф»); партию нужно указать только при браке. Если деталь окутывается в
            несколько заходов и сегодня не готова целиком — можно сохранить отчёт с 0 хороших и 0 брака, просто
            выбрав рулон: это зафиксирует расход плёнки и позволит вернуть/списать рулон, не дожидаясь готовой детали.
            Если на одну деталь ушло несколько разных рулонов — под полем «Рулон» появится «+ ещё рулон использован».
          </>
        )}
      </Typography.Paragraph>
      <Form
        layout="vertical"
        form={reportForm}
        initialValues={{
          assignment_id: presetAssignmentId ?? null,
          material_unit_id: line.issued_units.length === 1 ? line.issued_units[0].id : null,
          good_pieces: 0,
        }}
      >
        <Form.Item
          name="assignment_id"
          label={requiresDailyPlan ? "Распределение (день/линия)" : "Распределение (день/линия) — необязательно"}
          rules={requiresDailyPlan ? [{ required: true }] : []}
        >
          <Select
            allowClear={!requiresDailyPlan}
            disabled={!!presetAssignmentId}
            placeholder={requiresDailyPlan ? "Выберите день/линию распределения" : "Без привязки — участок без разбивки по дням"}
            options={line.assignments.map((a) => ({
              value: a.id,
              label: `${dayjs(a.date).format("DD.MM.YYYY")} — ${a.line_name} (${a.employee_names}), план ${a.quantity_pieces} шт`,
            }))}
            notFoundContent={
              <Typography.Text type="secondary">
                {requiresDailyPlan
                  ? "Сначала распределите строку по дням — кнопка «Распределить по дням»"
                  : "Участок без разбивки по дням — можно сохранить отчёт без распределения"}
              </Typography.Text>
            }
          />
        </Form.Item>
        {requiresRoll && (
          <Form.Item
            name="material_unit_id"
            label="Рулон (№ штрипса)"
            rules={[{ required: true, message: "Выберите рулон, из которого резали" }]}
          >
            <Select
              placeholder="Выберите рулон"
              options={line.issued_units.map((u) => ({
                value: u.id,
                label: `№${u.id} — ${u.width_mm}×${u.length_m} м`,
              }))}
              notFoundContent={
                <Typography.Text type="secondary">Сначала выдайте рулон этой строке на «Выдаче участку»</Typography.Text>
              }
            />
          </Form.Item>
        )}
        {requiresRoll && extraRolls.length > 0 && (
          <Form.Item label="Ещё рулоны, тоже использованы">
            <Space direction="vertical" size={4}>
              {extraRolls.map((extra, i) => (
                <Space key={extra.materialUnitId} size={4}>
                  <Tag
                    closable
                    onClose={() => setExtraRolls((prev) => prev.filter((_, idx) => idx !== i))}
                    style={{ marginRight: 0 }}
                  >
                    №{extra.materialUnitId}
                  </Tag>
                  <InputNumber
                    size="small"
                    min={0}
                    style={{ width: 70 }}
                    value={extra.qty}
                    placeholder="0"
                    onChange={(v) =>
                      setExtraRolls((prev) => prev.map((e, idx) => (idx === i ? { ...e, qty: v ?? 0 } : e)))
                    }
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    шт отсюда
                  </Typography.Text>
                </Space>
              ))}
            </Space>
          </Form.Item>
        )}
        {requiresRoll && primaryRollId != null && extraRollOptions.length > 0 && (
          <Form.Item
            label="+ ещё рулон использован"
            extra="Раздел про окутку в 2 захода — если на эту деталь ушло несколько разных рулонов, добавьте сюда все остальные и укажите, сколько готовых деталей получилось именно из каждого."
          >
            <Select<number>
              placeholder="Выберите ещё один рулон"
              value={undefined}
              onChange={(v) => setExtraRolls((prev) => [...prev, { materialUnitId: v, qty: 0 }])}
              options={extraRollOptions.map((u) => ({ value: u.id, label: `№${u.id} — ${u.width_mm}×${u.length_m} м` }))}
            />
          </Form.Item>
        )}
        <Form.Item name="good_pieces" label="Хороших деталей, шт" rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
      </Form>

      {defectRows.length > 0 && (
        <Table
          rowKey={(_, i) => String(i)}
          size="small"
          pagination={false}
          dataSource={defectRows}
          style={{ marginBottom: 16 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Причина брака", dataIndex: "reason", render: (v: string) => reasonName(v) },
            { title: "Кол-во, шт", dataIndex: "qty" },
            { title: "Партия п/ф", render: (_, r) => (r.part_unit_id != null ? `№${r.part_unit_id}` : "—") },
            { title: "Заметка", render: (_, r) => r.note ?? "—" },
            {
              title: "",
              render: (_, __, index) => (
                <Button size="small" danger onClick={() => removeDefectRow(index)}>
                  Убрать
                </Button>
              ),
            },
          ]}
        />
      )}

      <Typography.Title level={5}>Добавить причину брака</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь царапины:
        добавьте отдельную строку на каждую причину.
      </Typography.Paragraph>
      <Form form={defectRowForm} layout="vertical" onFinish={addDefectRow}>
        <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
          <Select
            loading={writeOffReasonsQuery.isLoading || partsReasonsQuery.isLoading}
            options={reasonOptions.map((r) => ({ value: r.code, label: r.name }))}
          />
        </Form.Item>
        <Form.Item name="qty" label="Количество, шт" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        {requiresRoll && (
          <Form.Item
            name="part_unit_id"
            label="Партия п/ф (опционально)"
            extra="Раздел про учёт по FIFO — для готовых деталей партия не выбирается, но брак физически обнаруживается в конкретной партии."
          >
            <Select
              allowClear
              loading={partUnitsQuery.isLoading}
              placeholder="Выберите партию"
              options={(partUnitsQuery.data ?? []).map((u) => ({
                value: u.id,
                label: `№${u.id} — ${u.quantity_pieces} шт, этап «${u.stage_name}»`,
              }))}
              notFoundContent={
                <Typography.Text type="secondary">
                  Партия не выдана этой строке (или у детали не настроены этапы) — «Учёт п/ф»
                </Typography.Text>
              }
            />
          </Form.Item>
        )}
        <Form.Item name="note" label="Заметка (опционально)">
          <Input placeholder="Например: мусор под плёнкой" />
        </Form.Item>
        <Button htmlType="submit" block>
          Добавить причину
        </Button>
      </Form>

      <Button
        type="primary"
        block
        style={{ marginTop: 16 }}
        loading={reportMutation.isPending}
        onClick={() => {
          reportForm
            .validateFields()
            .then((v) => {
              // Раздел про расход плёнки без готовой детали — 0/0
              // допустимо ТОЛЬКО когда выбран рулон (участок с
              // requiresRoll) — тогда это осознанный отчёт "рулон
              // использован, деталь не готова", а не пустая строка.
              const isMaterialOnlyReport = requiresRoll && (v.good_pieces ?? 0) <= 0 && defectRows.length === 0 && !!v.material_unit_id;
              if ((v.good_pieces ?? 0) <= 0 && defectRows.length === 0 && !isMaterialOnlyReport) {
                message.warning("Укажите хотя бы хорошие детали или причину брака");
                return;
              }
              reportMutation.mutate(v);
            })
            .catch(() => {});
        }}
      >
        Сохранить отчёт
      </Button>
    </Modal>
  );
}
