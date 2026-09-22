import { useState } from "react";
import { Modal, Form, Select, InputNumber, Input, Button, Table, Typography, message, Radio, Tag, Space } from "antd";
import dayjs from "dayjs";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createTaskLineReportsBatch, type ProductionTaskLine, type ProductionTaskLineReportCreate } from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { listPartUnits } from "../../../api/partUnits";
import { listParts } from "../../../api/dictionaries";
import RollPicker, { type RollPickerOption } from "../../../components/RollPicker";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

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
  area,
  onClose,
}: {
  taskId: number;
  line: ProductionTaskLine;
  presetAssignmentId?: number;
  requiresDailyPlan?: boolean;
  requiresRoll?: boolean;
  // Раздел про недостающую видимость остатка п/ф прямо в отчёте —
  // участок нужен, чтобы узнать, сколько партий п/ф реально доступно
  // (см. availableForLine ниже); не все вызывающие его знают напрямую
  // (line не хранит area родительского задания), поэтому необязателен.
  area?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const hasPartStages = !!area && (partsQuery.data ?? []).some((p) => p.stages.some((s) => s.area === area));
  const partUnitsQuery = useQuery({
    queryKey: ["part-units", "area", area],
    queryFn: () => listPartUnits({ area, status_: "Выдан_участку" }),
    enabled: hasPartStages,
  });
  const availableForLine = (() => {
    if (!hasPartStages || !line.part_name) return null;
    const part = (partsQuery.data ?? []).find((p) => p.name === line.part_name);
    if (!part) return null;
    return (partUnitsQuery.data ?? [])
      .filter((u) => u.part_id === part.id)
      .reduce((sum, u) => sum + u.quantity_available, 0);
  })();
  // Раздел про учёт п/ф по FIFO — партия и для готовых деталей, и для
  // брака списывается автоматически от самой старой по дате изготовления
  // (см. app/services/part_units.py::consume_defect_fifo), выбор партии
  // вручную убран целиком.
  const [defectRows, setDefectRows] = useState<
    { reason: string; qty: number; note?: string; disposition?: "spisat" | "pererabotka" }[]
  >([]);
  // Раздел про второй рулон на ту же строку — двусторонние детали часто
  // расходуют НЕСКОЛЬКО разных рулонов ОДНОВРЕМЕННО на ОДИН и тот же
  // комплект деталей (по одному на сторону, это не разные штуки), поэтому
  // "сколько деталей именно из него" не считаем — remainingM — известный
  // остаток именно ЭТОГО рулона прямо сейчас, м (видно на самом рулоне).
  // При сохранении по нему подбирается такой good_pieces, чтобы расчётный
  // остаток рулона (_unit_consumed_length_m) совпал с этим числом; отчёт
  // уходит с counts_toward_line=false, чтобы не задвоить план строки (эти
  // же детали уже засчитаны основным отчётом). remainingM=0 — рулон
  // израсходован полностью.
  const [extraRolls, setExtraRolls] = useState<{ materialUnitId: number; remainingM: number }[]>([]);
  // Раздел про то, что «нулевой отчёт» больше нельзя занести молча —
  // когда 0 хороших и 0 брака, но рулон трогали, мастер вводит его
  // фактический остаток, м (пусто = не трогали, расход 0).
  const [primaryRemainingM, setPrimaryRemainingM] = useState<number | undefined>(undefined);
  const [reportForm] = Form.useForm<{
    assignment_id: number | null;
    material_unit_id: number | null;
    good_pieces: number;
  }>();
  const [defectRowForm] = Form.useForm<{ reason: string; qty: number; note?: string; disposition?: "spisat" | "pererabotka" }>();
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

  const addDefectRow = (v: { reason: string; qty: number; note?: string; disposition?: "spisat" | "pererabotka" }) => {
    setDefectRows((rows) => [...rows, v]);
    defectRowForm.resetFields();
  };
  const removeDefectRow = (index: number) => setDefectRows((rows) => rows.filter((_, i) => i !== index));

  // Раздел про сбой формы отчёта — несколько payload'ов одного клика
  // "Сохранить" (основной good_pieces + причины брака + доп. рулоны)
  // раньше слались независимыми запросами (Promise.all): если один
  // падал уже ПОСЛЕ того, как другие успели закоммититься по отдельности,
  // повторный клик пересылал всё заново, задваивая уже прошедшее
  // (реальный случай — брак списался 8 раз вместо одного). Теперь — один
  // batch-запрос на всю строку одной транзакцией на бэкенде
  // (create_task_line_reports_batch): либо коммитится всё разом, либо
  // ничего — повторный клик безопасен, а ошибка показывает настоящую
  // причину вместо общей фразы.
  const reportMutation = useMutation({
    mutationFn: async (v: {
      assignment_id: number | null;
      material_unit_id: number | null;
      good_pieces: number;
    }) => {
      const payloads: ProductionTaskLineReportCreate[] = [];
      if (v.good_pieces > 0) {
        payloads.push({
          assignment_id: v.assignment_id,
          material_unit_id: v.material_unit_id,
          good_pieces: v.good_pieces,
          defect_pieces: 0,
        });
      }
      for (const row of defectRows) {
        payloads.push({
          assignment_id: v.assignment_id,
          material_unit_id: v.material_unit_id,
          good_pieces: 0,
          defect_pieces: row.qty,
          defect_reason: row.reason,
          defect_disposition: row.disposition,
          note: row.note,
        });
      }
      // Раздел про расход плёнки без готовой детали (окутка в 2 захода) —
      // ни хороших, ни брака ещё нет (деталь физически не готова), но
      // рулон уже трогали. Раньше слался "нулевой" отчёт (good=0/defect=0)
      // — рулон навсегда выглядел нетронутым. Теперь мастер вводит
      // фактический остаток этого рулона: расход считается из (было −
      // остаток), отчёт с counts_toward_line=false (факт использования
      // всё так же фиксируется — рулон можно вернуть/списать). Пустой
      // остаток = не трогали → good_pieces 0, как раньше.
      if (requiresRoll && v.good_pieces <= 0 && defectRows.length === 0 && v.material_unit_id) {
        const pu =
          line.issued_units.find((u) => u.id === v.material_unit_id) ??
          (line.borrowable_units ?? []).find((u) => u.id === v.material_unit_id);
        const puRemaining = pu?.remaining_length_m ?? pu?.length_m ?? 0;
        const target = primaryRemainingM ?? puRemaining;
        const consumedNeeded = Math.max(0, puRemaining - target);
        const gp = line.length_m > 0 ? consumedNeeded / line.length_m : 0;
        payloads.push({
          assignment_id: v.assignment_id,
          material_unit_id: v.material_unit_id,
          good_pieces: gp,
          defect_pieces: 0,
          counts_toward_line: false,
          note:
            primaryRemainingM != null
              ? `Остаток указан вручную: ${primaryRemainingM} м`
              : "Рулон использован, деталь ещё не готова",
        });
      }
      // Раздел про второй рулон на ту же строку (двусторонние детали) —
      // это те же самые детали, что и good_pieces выше, просто ещё один
      // рулон физически тоже участвовал (другая сторона) — "сколько
      // деталей именно из него" не считаем, вместо этого подбираем
      // good_pieces под указанный вручную остаток ЭТОГО рулона и шлём
      // отдельным отчётом с counts_toward_line=false, чтобы не задвоить
      // план строки (эти детали уже учтены основным отчётом выше).
      for (const extra of extraRolls) {
        const unit =
          line.issued_units.find((u) => u.id === extra.materialUnitId) ??
          (line.borrowable_units ?? []).find((u) => u.id === extra.materialUnitId);
        const currentRemaining = unit?.remaining_length_m ?? unit?.length_m ?? 0;
        const consumedNeeded = Math.max(0, currentRemaining - extra.remainingM);
        const goodPiecesEquivalent = line.length_m > 0 ? consumedNeeded / line.length_m : 0;
        payloads.push({
          assignment_id: v.assignment_id,
          material_unit_id: extra.materialUnitId,
          good_pieces: goodPiecesEquivalent,
          defect_pieces: 0,
          counts_toward_line: false,
          note: `Остаток указан вручную: ${extra.remainingM} м`,
        });
      }
      if (payloads.length > 0) await createTaskLineReportsBatch(taskId, line.id, payloads);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Отчёт сохранён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить отчёт")),
  });

  const primaryRollId = Form.useWatch("material_unit_id", reportForm) as number | null | undefined;
  // Раздел про общий штрипс на детали одного задания — к своим выданным
  // рулонам добавляем рулоны соседних строк того же задания с такой же
  // шириной штрипса (borrowable_units), помечая, с какой детали. Один
  // список для RollPicker вместо раздельных "Рулон"/"+ ещё рулон".
  const rollPickerOptions: RollPickerOption[] = [
    ...line.issued_units.map((u) => ({ value: u.id, widthMm: u.width_mm, remainingM: u.remaining_length_m ?? u.length_m, own: true })),
    ...(line.borrowable_units ?? []).map((u) => ({
      value: u.id,
      widthMm: u.width_mm,
      remainingM: u.remaining_length_m ?? u.length_m,
      own: false,
      fromPartName: u.from_part_name,
    })),
  ];

  // Раздел про общий штрипс на детали одного задания — мягкое
  // предупреждение, если на введённые хорошие детали не хватает метража
  // выбранного рулона (своего или заимствованного). Сабмит не блокируем.
  const goodPiecesWatch = (Form.useWatch("good_pieces", reportForm) as number | undefined) ?? 0;
  const selectedRoll =
    primaryRollId == null
      ? undefined
      : line.issued_units.find((u) => u.id === primaryRollId) ??
        (line.borrowable_units ?? []).find((u) => u.id === primaryRollId);
  const selectedRemain = selectedRoll?.remaining_length_m ?? selectedRoll?.length_m;
  const meterageNeed = goodPiecesWatch * line.length_m;
  const meterageShort =
    selectedRemain != null && meterageNeed > selectedRemain
      ? { remain: selectedRemain, need: meterageNeed, good: goodPiecesWatch }
      : null;

  return (
    <Modal title={`Отчёт по линии «${line.part_name ?? line.line_name}»`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Нужно: {line.quantity_pieces} шт, уже произведено: {line.produced_good_pieces} шт, остаток: {line.remaining_pieces} шт.
        {requiresRoll && (
          <>
            {" "}Партия п/ф не выбирается вручную ни для готовых деталей, ни для брака — списывается автоматически от
            самой старой по дате изготовления («Учёт п/ф»). Если деталь окутывается в несколько заходов и сегодня не
            готова целиком — можно сохранить отчёт с 0 хороших и 0 брака, просто
            выбрав рулон: это зафиксирует расход плёнки и позволит вернуть/списать рулон, не дожидаясь готовой детали.
            Если деталь двусторонняя и на неё одновременно расходуется ещё один рулон (по одному на сторону — это те
            же самые детали, не дополнительные) — под полем «Рулон» появится «+ ещё рулон использован»: укажите для
            него фактический остаток в метрах прямо сейчас (0 — израсходован полностью).
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
            label="Рулон(ы), из которых резали"
            rules={[{ required: true, message: "Выберите хотя бы один рулон" }]}
          >
            <RollPicker options={rollPickerOptions} extraRolls={extraRolls} onExtraRollsChange={setExtraRolls} />
          </Form.Item>
        )}
        {requiresRoll && primaryRollId != null && goodPiecesWatch <= 0 && defectRows.length === 0 && (
          <Form.Item
            label="Остаток на этом рулоне сейчас, м (деталь ещё не готова)"
            extra="Оставьте пустым, если рулон ещё не трогали. 0 — израсходован полностью. Из этого числа считается расход рулона."
          >
            <InputNumber
              min={0}
              style={{ width: "100%" }}
              value={primaryRemainingM}
              placeholder="не трогали"
              onChange={(v) => setPrimaryRemainingM(v ?? undefined)}
            />
          </Form.Item>
        )}
        <Form.Item name="good_pieces" label="Хороших деталей, шт" rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        {availableForLine != null && (
          <Space size={4} style={{ marginTop: -8, marginBottom: 16 }}>
            <Tag color="default" style={{ margin: 0, fontSize: 11 }}>
              доступно партий п/ф: {Math.round(availableForLine * 100) / 100} шт
            </Tag>
            <a style={{ fontSize: 11 }} onClick={() => navigate("/part-units", { state: { partFilter: line.part_name } })}>
              Учёт п/ф →
            </a>
          </Space>
        )}
        {meterageShort != null && (
          <Typography.Paragraph type="warning" style={{ marginTop: -8 }}>
            На выбранном рулоне остаток {meterageShort.remain} м, а на {meterageShort.good} деталей нужно ~
            {meterageShort.need.toFixed(1)} м. Проверьте, хватает ли метража (сохранить всё равно можно).
          </Typography.Paragraph>
        )}
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
            {
              title: "Судьба",
              render: (_, r) => (r.disposition === "pererabotka" ? <Tag color="blue">♻️ в переработку</Tag> : "списан"),
            },
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
      <Form form={defectRowForm} layout="vertical" initialValues={{ disposition: "spisat" }} onFinish={addDefectRow}>
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
            name="disposition"
            label="Что с браком"
            extra="«В переработку» резервирует материал (не списывает насовсем) — из него потом можно сделать партию другой детали («Учёт п/ф» → «Переработать в деталь»)."
          >
            <Radio.Group
              options={[
                { label: "Списать насовсем", value: "spisat" },
                { label: "♻️ В переработку", value: "pererabotka" },
              ]}
              optionType="button"
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
