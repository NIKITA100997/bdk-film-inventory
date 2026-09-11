import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Card, Space, Typography, Form, InputNumber, Input, Select, Button, Checkbox, message, Modal, Popconfirm, Table, Tag, DatePicker } from "antd";
import type { Dayjs } from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ActionIcon from "../../../components/ActionIcon";
import PrintFormatButton from "../../../components/PrintFormatButton";
import PartSelect from "../../../components/PartSelect";
import { printPartUnitLabel } from "../../../api/partLabels";
import {
  listPartUnits,
  createPartUnit,
  issuePartUnit,
  writeOffPartUnit,
  advancePartUnit,
  returnPartUnit,
  adjustPartUnit,
  listPartUnitEvents,
  type PartUnit,
  type PartUnitStatus,
} from "../../../api/partUnits";
import { listProductionTasks } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listParts, type Part } from "../../../api/dictionaries";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { placePartUnit } from "../../../api/partStorage";
import { listUsers } from "../../../api/users";
import { useAuth } from "../../../auth/AuthContext";

const STATUS_LABEL: Record<PartUnitStatus, string> = {
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
};

const STATUS_TAG_COLOR: Record<PartUnitStatus, string> = {
  На_хранении: "blue",
  Выдан_участку: "green",
  Списан: "red",
};

interface MintFormValues {
  quantity_pieces: number;
  task_line_key?: string;
  issue: boolean;
  note?: string;
  stage_id?: number;
  // Раздел про учёт п/ф по FIFO — не задано = сегодня (бэкенд сам
  // подставит), задаётся только для регистрации задним числом.
  manufactured_at?: Dayjs;
}

/** Учёт производства деталей (раздел про физический учёт деталей, пилот:
 * окутка царговых) — деталь из задания больше не просто строка с числом,
 * а физическая партия (лот в штуках) со своим статусом (на хранении/
 * выдана участку/списана) и этапом обработки (свой список у каждой
 * детали — см. PartsAdmin.tsx). Регистрирует начальник цеха: резка
 * дерева/МДФ сегодня нигде не участок, поэтому отдельный экран, а не
 * часть заданий/отчётов конкретного участка. Партия, выданная участку,
 * дальше переходит на следующий этап (или списывается) прямо из отчёта
 * мастера (см. ReportModal.tsx/MasterQuickReportPanel.tsx).
 *
 * Раздел про плотную таблицу-очередь (дорожная карта развития —
 * https://claude.ai/code/artifact/0b49ac59-3761-413e-8382-32cf72a07366,
 * тот же чертёж, что уже довели в «Выдаче участку»): dense `Table`
 * вместо ResponsiveTable, фильтры по статусу/этапу/участку, иконки-
 * действия (`ActionIcon`, общий с Issue.tsx) вместо инлайн-Select на
 * "Выдать участку". Клик по строке — «карточка партии» (журнал событий),
 * тот же паттерн, что уже даёт клик по единице в «Истории приёмок». */
export default function PartUnits() {
  const { user } = useAuth();
  const location = useLocation();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("part_units.manage");
  // Раздел про ревизию путей плёнки/п/ф — узкое право, отдельное от
  // part_units.manage: обычная выдача/списание доступны начальнику
  // цеха, формальный возврат/корректировка — только тому, кому явно
  // доверили (обычно админ/начальник склада).
  const canCorrect = !!user?.is_superuser || !!user?.permissions.includes("part_units.correct");
  const qc = useQueryClient();
  const [form] = Form.useForm<MintFormValues>();
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<PartUnit | null>(null);
  const [writeOffForm] = Form.useForm<{ quantity_pieces: number; reason: string; note?: string }>();
  const [advanceTarget, setAdvanceTarget] = useState<PartUnit | null>(null);
  const [advanceForm] = Form.useForm<{ quantity_pieces: number }>();
  const [placeTarget, setPlaceTarget] = useState<PartUnit | null>(null);
  const [placeLocationCode, setPlaceLocationCode] = useState("");
  const [cardTarget, setCardTarget] = useState<PartUnit | null>(null);
  // Раздел про ревизию путей плёнки/п/ф — возврат на склад (партия
  // выдана участку, но физически не использована/использована лишь
  // частично) и формальная корректировка количества (вместо правки
  // истории напрямую в БД).
  const [returnTarget, setReturnTarget] = useState<PartUnit | null>(null);
  const [returnForm] = Form.useForm<{ actual_quantity_pieces: number }>();
  const [adjustTarget, setAdjustTarget] = useState<PartUnit | null>(null);
  const [adjustForm] = Form.useForm<{ actual_quantity_pieces: number; reason: string; note?: string }>();

  const [partFilter, setPartFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<PartUnitStatus | undefined>(undefined);
  const [stageFilter, setStageFilter] = useState<string | undefined>(undefined);

  const unitsQuery = useQuery({ queryKey: ["part-units"], queryFn: () => listPartUnits() });

  // Раздел про сканирование "ПФ<id>" (unitSearch.ts) — открыть карточку
  // партии сразу после перехода, как только список партий загрузится
  // (иначе искать не в чем).
  useEffect(() => {
    const state = location.state as { openUnitId?: number } | null;
    if (!state?.openUnitId || !unitsQuery.data) return;
    const found = unitsQuery.data.find((u) => u.id === state.openUnitId);
    if (found) setCardTarget(found);
  }, [location.state, unitsQuery.data]);
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;

  // Карта stage_id -> имя этапа, по всем деталям сразу (для карточки
  // партии — там встречаются from/to этапы события, которые могут не
  // совпадать с ТЕКУЩИМ этапом партии, только через полный список этапов
  // по её детали можно назвать их по имени, не по голому id).
  const stageNameById = new Map<number, string>();
  const stageAreaById = new Map<number, string | null>();
  for (const p of partsQuery.data ?? []) for (const s of p.stages) {
    stageNameById.set(s.id, s.name);
    stageAreaById.set(s.id, s.area);
  }
  const stageName = (id: number | null) => (id == null ? null : (stageNameById.get(id) ?? `#${id}`));

  const eventsQuery = useQuery({
    queryKey: ["part-unit-events", cardTarget?.id],
    queryFn: () => listPartUnitEvents(cardTarget!.id),
    enabled: !!cardTarget,
  });

  const taskLineOptions = (tasksQuery.data ?? [])
    .filter((t) => t.is_active)
    .flatMap((t) =>
      t.lines.map((l) => ({
        value: `${t.id}:${l.id}`,
        label: `${t.product_model_name ?? t.name ?? `Задание №${t.id}`} — ${l.part_name ?? l.material}`,
      })),
    );

  const taskLineLabel = (id: number | null) => {
    if (id == null) return "—";
    for (const t of tasksQuery.data ?? []) {
      const line = t.lines.find((l) => l.id === id);
      if (line) return `${t.product_model_name ?? t.name ?? `Задание №${t.id}`} — ${line.part_name ?? line.material}`;
    }
    return `#${id}`;
  };

  const mintMutation = useMutation({
    mutationFn: (v: MintFormValues) => {
      const lineIdStr = v.task_line_key ? v.task_line_key.split(":")[1] : undefined;
      return createPartUnit({
        part_id: selectedPart!.id,
        quantity_pieces: v.quantity_pieces,
        production_task_line_id: lineIdStr ? Number(lineIdStr) : undefined,
        issue: v.issue,
        note: v.note,
        stage_id: v.stage_id,
        manufactured_at: v.manufactured_at ? v.manufactured_at.format("YYYY-MM-DD") : undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия зарегистрирована");
      form.resetFields();
      setSelectedPart(null);
    },
    onError: () => message.error("Не удалось зарегистрировать партию — у детали настроены этапы?"),
  });

  const issueMutation = useMutation({
    mutationFn: (id: number) => issuePartUnit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия выдана участку");
    },
    onError: () => message.error("Не удалось выдать партию — у этапа не назначен участок?"),
  });

  const placeMutation = useMutation({
    mutationFn: ({ id, locationCode }: { id: number; locationCode: string }) => placePartUnit(id, locationCode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["part-rack-occupancy"] });
      message.success("Партия размещена");
      setPlaceTarget(null);
      setPlaceLocationCode("");
    },
    onError: () => message.error("Не удалось разместить партию"),
  });

  const writeOffMutation = useMutation({
    mutationFn: (v: { quantity_pieces: number; reason: string; note?: string }) => writeOffPartUnit(writeOffTarget!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия списана");
      setWriteOffTarget(null);
      writeOffForm.resetFields();
    },
    onError: () => message.error("Не удалось списать партию"),
  });

  // Раздел про мобильный скан-сценарий по этапам — тот же прямой перевод,
  // что теперь доступен и со сканера на телефоне (PartUnitCard.tsx), для
  // симметрии здесь тоже, не только на мобильном.
  const advanceMutation = useMutation({
    mutationFn: (v: { quantity_pieces: number }) => advancePartUnit(advanceTarget!.id, v.quantity_pieces),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success(`Переведена на этап «${u.stage_name}»`);
      setAdvanceTarget(null);
      advanceForm.resetFields();
    },
    onError: () => message.error("Не удалось перевести на следующий этап"),
  });

  const returnMutation = useMutation({
    mutationFn: (v: { actual_quantity_pieces: number }) => returnPartUnit(returnTarget!.id, v.actual_quantity_pieces),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия возвращена на склад");
      setReturnTarget(null);
      returnForm.resetFields();
    },
    onError: () => message.error("Не удалось вернуть партию на склад"),
  });

  const adjustMutation = useMutation({
    mutationFn: (v: { actual_quantity_pieces: number; reason: string; note?: string }) => adjustPartUnit(adjustTarget!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Количество скорректировано");
      setAdjustTarget(null);
      adjustForm.resetFields();
    },
    onError: () => message.error("Не удалось скорректировать партию"),
  });

  const nextStageName = (u: PartUnit): string | null => {
    const part = partsQuery.data?.find((p) => p.id === u.part_id);
    if (!part) return null;
    const stages = [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order);
    const idx = stages.findIndex((s) => s.id === u.stage_id);
    if (idx === -1 || idx + 1 >= stages.length) return null;
    return stages[idx + 1].name;
  };

  const allUnits = unitsQuery.data ?? [];
  const stageOptions = [...new Set(allUnits.map((u) => u.stage_name))].map((s) => ({ value: s, label: s }));
  const filteredUnits = allUnits.filter((u) => {
    if (partFilter.trim() && !u.part_name.toLowerCase().includes(partFilter.trim().toLowerCase())) return false;
    if (areaFilter && u.area !== areaFilter) return false;
    if (statusFilter && u.status !== statusFilter) return false;
    if (stageFilter && u.stage_name !== stageFilter) return false;
    return true;
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {canManage && (
        <Card title="Зарегистрировать партию">
          <Form
            layout="vertical"
            form={form}
            onFinish={(v) => {
              if (!selectedPart) {
                message.warning("Выберите деталь");
                return;
              }
              mintMutation.mutate(v);
            }}
          >
            <Form.Item label="Деталь">
              <PartSelect
                onSelect={(p) => {
                  setSelectedPart(p);
                  form.setFieldValue("stage_id", undefined);
                }}
                placeholder="Найдите деталь в справочнике"
              />
              {selectedPart && <Typography.Text type="secondary">Выбрано: {selectedPart.name}</Typography.Text>}
            </Form.Item>
            {selectedPart && selectedPart.stages.length > 1 && (
              <Form.Item
                name="stage_id"
                label="Начальный этап"
                extra="Партия уже прошла часть маршрута (например, уже склеена и отфрезерована) и заводится в систему только сейчас — по умолчанию первый этап."
              >
                <Select
                  allowClear
                  placeholder={selectedPart.stages[0].name}
                  options={[...selectedPart.stages]
                    .sort((a, b) => a.sequence_order - b.sequence_order)
                    .map((s) => ({ value: s.id, label: s.name }))}
                />
              </Form.Item>
            )}
            <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="manufactured_at"
              label="Дата изготовления (опционально)"
              extra="Раздел про учёт по FIFO — по этой дате партии расходуются от самой старой при отчёте о готовых деталях. Не указано — сегодня."
            >
              <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" placeholder="Сегодня" disabledDate={(d) => d.isAfter(Date.now(), "day")} />
            </Form.Item>
            <Form.Item name="task_line_key" label="Строка задания (опционально)">
              <Select
                showSearch
                allowClear
                placeholder="Без привязки — безадресный запас"
                options={taskLineOptions}
                filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
            <Form.Item name="issue" valuePropName="checked" initialValue={false}>
              <Checkbox>Сразу выдать участку (участок — из выбранного этапа)</Checkbox>
            </Form.Item>
            <Form.Item name="note" label="Заметка (опционально)">
              <Input />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={mintMutation.isPending}>
              Зарегистрировать
            </Button>
          </Form>
        </Card>
      )}

      <Card title="Остатки партий">
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          Кликните строку, чтобы открыть карточку партии (журнал событий).
        </Typography.Paragraph>
        <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
          <Input
            allowClear
            placeholder="Поиск по детали…"
            style={{ width: 220, maxWidth: "100%" }}
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
          />
          <Select
            allowClear
            placeholder="Все участки"
            style={{ width: 200, maxWidth: "100%" }}
            options={areaOptions}
            value={areaFilter}
            onChange={setAreaFilter}
          />
          <Select
            allowClear
            placeholder="Все статусы"
            style={{ width: 180, maxWidth: "100%" }}
            options={(Object.keys(STATUS_LABEL) as PartUnitStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            value={statusFilter}
            onChange={setStatusFilter}
          />
          <Select
            allowClear
            placeholder="Все этапы"
            style={{ width: 200, maxWidth: "100%" }}
            options={stageOptions}
            value={stageFilter}
            onChange={setStageFilter}
          />
        </Space>

        <Table<PartUnit>
          size="small"
          tableLayout="fixed"
          rowKey="id"
          loading={unitsQuery.isLoading}
          dataSource={filteredUnits}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1270 }}
          locale={{ emptyText: "Ничего не найдено по текущему фильтру" }}
          onRow={(u) => ({ onClick: () => setCardTarget(u), style: { cursor: "pointer" } })}
          columns={[
            { title: "Деталь", dataIndex: "part_name", width: 220 },
            { title: "Кол-во, шт", dataIndex: "quantity_pieces", width: 90 },
            {
              // Раздел про учёт п/ф по FIFO — видимость даты, по которой
              // партии теперь расходуются автоматически (не по номеру).
              title: "Изготовлено",
              dataIndex: "manufactured_at",
              width: 110,
              render: (v: string) => new Date(v).toLocaleDateString("ru-RU"),
            },
            { title: "Этап", dataIndex: "stage_name", width: 130, ellipsis: true },
            {
              title: "Статус",
              width: 120,
              render: (_, u) => <Tag color={STATUS_TAG_COLOR[u.status]}>{STATUS_LABEL[u.status]}</Tag>,
            },
            { title: "Место", width: 100, ellipsis: true, render: (_, u) => u.location_code ?? "—" },
            { title: "Участок", width: 130, ellipsis: true, render: (_, u) => areaLabel(u.area) },
            { title: "Задание", width: 220, ellipsis: true, render: (_, u) => taskLineLabel(u.production_task_line_id) },
            {
              title: "Действия",
              width: 150,
              render: (_, u) => (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <PrintFormatButton
                    variant="icon"
                    tip="Печать этикетки"
                    onPrint={(pageFormat) => printPartUnitLabel(u.id, { pageFormat })}
                  >
                    🖨
                  </PrintFormatButton>
                  {canManage && u.status === "На_хранении" && (
                    <ActionIcon
                      tone="outline"
                      tip="Разместить на стеллаж"
                      onClick={() => {
                        setPlaceTarget(u);
                        setPlaceLocationCode(u.location_code ?? "");
                      }}
                    >
                      📦
                    </ActionIcon>
                  )}
                  {canManage && u.status === "На_хранении" && (
                    <Popconfirm
                      title={`Выдать партию участку «${areaLabel(stageAreaById.get(u.stage_id) ?? null)}»?`}
                      okText="Выдать"
                      cancelText="Отмена"
                      onConfirm={() => issueMutation.mutate(u.id)}
                    >
                      <span>
                        <ActionIcon tone="filled" tip="Выдать участку">
                          📤
                        </ActionIcon>
                      </span>
                    </Popconfirm>
                  )}
                  {canManage && u.status === "Выдан_участку" && (
                    <ActionIcon
                      tone="outline"
                      tip="Перевести на следующий этап"
                      onClick={() => {
                        setAdvanceTarget(u);
                        advanceForm.setFieldsValue({ quantity_pieces: u.quantity_pieces });
                      }}
                    >
                      ➡️
                    </ActionIcon>
                  )}
                  {canManage && u.status !== "Списан" && (
                    <ActionIcon tone="ghost" danger tip="Списать" onClick={() => setWriteOffTarget(u)}>
                      ✖
                    </ActionIcon>
                  )}
                  {canCorrect && u.status === "Выдан_участку" && (
                    <ActionIcon
                      tone="outline"
                      tip="Вернуть на склад"
                      onClick={() => {
                        setReturnTarget(u);
                        returnForm.setFieldsValue({ actual_quantity_pieces: u.quantity_pieces });
                      }}
                    >
                      📥
                    </ActionIcon>
                  )}
                  {canCorrect && (
                    <ActionIcon
                      tone="outline"
                      tip="Скорректировать количество"
                      onClick={() => {
                        setAdjustTarget(u);
                        adjustForm.setFieldsValue({ actual_quantity_pieces: u.quantity_pieces });
                      }}
                    >
                      🛠
                    </ActionIcon>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={`Разместить партию «${placeTarget?.part_name ?? ""}»`}
        open={!!placeTarget}
        onCancel={() => {
          setPlaceTarget(null);
          setPlaceLocationCode("");
        }}
        footer={null}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Typography.Text type="secondary">
            {placeTarget?.quantity_pieces} шт, этап «{placeTarget?.stage_name}»
            {placeTarget?.location_code && <> · сейчас на {placeTarget.location_code}</>}
          </Typography.Text>
          <Input
            placeholder="Например, ЗГ-1-01"
            value={placeLocationCode}
            onChange={(e) => setPlaceLocationCode(e.target.value)}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Схему стеллажей и свободные полки удобнее смотреть на «Стеллажи п/ф».
          </Typography.Text>
          <Button
            type="primary"
            block
            loading={placeMutation.isPending}
            disabled={!placeLocationCode.trim()}
            onClick={() => placeMutation.mutate({ id: placeTarget!.id, locationCode: placeLocationCode.trim() })}
          >
            Разместить
          </Button>
        </Space>
      </Modal>

      <Modal
        title={`Списать партию «${writeOffTarget?.part_name ?? ""}»`}
        open={!!writeOffTarget}
        onCancel={() => setWriteOffTarget(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={writeOffForm}
          initialValues={{ quantity_pieces: writeOffTarget?.quantity_pieces }}
          onFinish={(v) => writeOffMutation.mutate(v)}
        >
          <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={0.01} max={writeOffTarget?.quantity_pieces} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
            <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input />
          </Form.Item>
          <Button type="primary" danger htmlType="submit" block loading={writeOffMutation.isPending}>
            Списать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Перевести партию «${advanceTarget?.part_name ?? ""}» на следующий этап`}
        open={!!advanceTarget}
        onCancel={() => setAdvanceTarget(null)}
        footer={null}
        destroyOnHidden
      >
        {advanceTarget &&
          (nextStageName(advanceTarget) ? (
            <Typography.Paragraph type="secondary">
              Следующий этап: «{nextStageName(advanceTarget)}»
            </Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="secondary">
              Это последний этап — партия будет отмечена как «Завершение».
            </Typography.Paragraph>
          ))}
        <Form
          layout="vertical"
          form={advanceForm}
          initialValues={{ quantity_pieces: advanceTarget?.quantity_pieces }}
          onFinish={(v) => advanceMutation.mutate(v)}
        >
          <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={0.01} max={advanceTarget?.quantity_pieces} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={advanceMutation.isPending}>
            Перевести
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Вернуть партию «${returnTarget?.part_name ?? ""}» на склад`}
        open={!!returnTarget}
        onCancel={() => setReturnTarget(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Выдано было {returnTarget?.quantity_pieces} шт. Укажите, сколько реально возвращается — если
          часть физически ушла в дело без отдельного отчёта, разница просто зафиксируется событием.
        </Typography.Paragraph>
        <Form
          layout="vertical"
          form={returnForm}
          initialValues={{ actual_quantity_pieces: returnTarget?.quantity_pieces }}
          onFinish={(v) => returnMutation.mutate(v)}
        >
          <Form.Item name="actual_quantity_pieces" label="Фактически возвращается, шт" rules={[{ required: true }]}>
            <InputNumber min={0} max={returnTarget?.quantity_pieces} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={returnMutation.isPending}>
            Вернуть на склад
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Скорректировать партию «${adjustTarget?.part_name ?? ""}»`}
        open={!!adjustTarget}
        onCancel={() => setAdjustTarget(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Сейчас в системе {adjustTarget?.quantity_pieces} шт. Формальная правка вместо изменения истории
          напрямую — действие добавит запись в журнал партии, причина обязательна.
        </Typography.Paragraph>
        <Form
          layout="vertical"
          form={adjustForm}
          initialValues={{ actual_quantity_pieces: adjustTarget?.quantity_pieces }}
          onFinish={(v) => adjustMutation.mutate(v)}
        >
          <Form.Item name="actual_quantity_pieces" label="Фактическое количество, шт" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Укажите причину корректировки" }]}>
            <Input placeholder="Например: опечатка при вводе" />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={adjustMutation.isPending}>
            Скорректировать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={cardTarget ? `Партия «${cardTarget.part_name}»` : ""}
        open={!!cardTarget}
        onCancel={() => setCardTarget(null)}
        footer={null}
        width={640}
        destroyOnHidden
      >
        {cardTarget && (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                background: "#F5F5F4",
                borderRadius: 10,
                padding: "12px 16px",
                fontSize: 13,
              }}
            >
              <div>
                <Typography.Text type="secondary">Кол-во</Typography.Text>
                <div>
                  <b>{cardTarget.quantity_pieces} шт</b>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">Этап</Typography.Text>
                <div>
                  <b>{cardTarget.stage_name}</b>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">Статус</Typography.Text>
                <div>
                  <Tag color={STATUS_TAG_COLOR[cardTarget.status]} style={{ marginTop: 2 }}>
                    {STATUS_LABEL[cardTarget.status]}
                  </Tag>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">Участок</Typography.Text>
                <div>
                  <b>{areaLabel(cardTarget.area)}</b>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary">Место</Typography.Text>
                <div>
                  <b>{cardTarget.location_code ?? "—"}</b>
                </div>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <Typography.Text type="secondary">Задание</Typography.Text>
                <div>
                  <b>{taskLineLabel(cardTarget.production_task_line_id)}</b>
                </div>
              </div>
              {cardTarget.note && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <Typography.Text type="secondary">Заметка</Typography.Text>
                  <div>{cardTarget.note}</div>
                </div>
              )}
            </div>

            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                История
              </Typography.Text>
              <Space direction="vertical" size={0} style={{ width: "100%", marginTop: 6 }}>
                {(eventsQuery.data ?? []).map((ev, i) => (
                  <div
                    key={ev.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      padding: "10px 0",
                      borderTop: i === 0 ? "none" : "1px solid #DEDEDA",
                      fontSize: 13,
                    }}
                  >
                    <Tag style={{ margin: 0, flexShrink: 0, height: "fit-content" }}>{ev.event_type.replace(/_/g, " ")}</Tag>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        {ev.quantity_delta > 0 ? "+" : ""}
                        {ev.quantity_delta} шт
                        {ev.from_stage_id != null && ev.to_stage_id != null && (
                          <>
                            {" "}
                            · {stageName(ev.from_stage_id)} → {stageName(ev.to_stage_id)}
                          </>
                        )}
                        {ev.to_cell && (
                          <>
                            {" "}
                            · {ev.from_cell ? `${ev.from_cell} → ${ev.to_cell}` : ev.to_cell}
                          </>
                        )}
                        {ev.area && <> · {areaLabel(ev.area)}</>}
                        {ev.write_off_reason && (
                          <> · причина: {reasonsQuery.data?.find((r) => r.code === ev.write_off_reason)?.name ?? ev.write_off_reason}</>
                        )}
                      </div>
                      {ev.note && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {ev.note}
                        </Typography.Text>
                      )}
                      <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
                        {new Date(ev.occurred_at).toLocaleString("ru-RU")} — {userName(ev.user_id)}
                      </div>
                    </div>
                  </div>
                ))}
                {eventsQuery.isLoading && <Typography.Text type="secondary">Загрузка…</Typography.Text>}
                {!eventsQuery.isLoading && (eventsQuery.data ?? []).length === 0 && (
                  <Typography.Text type="secondary">Событий пока нет</Typography.Text>
                )}
              </Space>
            </div>
          </Space>
        )}
      </Modal>
    </Space>
  );
}
