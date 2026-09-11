import { useEffect, useState } from "react";
import { Button, Card, Form, Input, InputNumber, Typography, Descriptions, Alert, Tag, List, Space, Modal, Select, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import {
  getPartUnit,
  issuePartUnit,
  writeOffPartUnit,
  advancePartUnit,
  listPartUnitEvents,
  type PartUnit,
} from "../../api/partUnits";
import { placePartUnit } from "../../api/partStorage";
import { listParts } from "../../api/dictionaries";
import { listUsers } from "../../api/users";
import { listAreas } from "../../api/areas";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import QrScanButton from "../../components/QrScanButton";

type ActionKind = "place" | "advance" | null;

const statusLabels: Record<string, string> = {
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
};

/** Мобильная карточка партии п/ф (раздел про мобильный скан-сценарий по
 * этапам) — зеркалит UnitCard.tsx (плёнка): скан/поиск → карточка →
 * действия по статусу → история. Партия без задания просто переезжает
 * между этапами напрямую (advancePartUnit), не через отчёт о
 * производстве — тот путь остаётся для «Окутки», где реально
 * расходуется плёнка (см. ReportModal/MasterQuickReportPanel). */
export default function PartUnitCard() {
  const location = useLocation();
  const qc = useQueryClient();
  const [unit, setUnit] = useState<PartUnit | null>(null);
  const [action, setAction] = useState<ActionKind>(null);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [scanForm] = Form.useForm<{ id: number }>();
  const [placeForm] = Form.useForm<{ location_code: string }>();
  const [advanceForm] = Form.useForm<{ quantity_pieces: number }>();
  const [writeOffForm] = Form.useForm<{ quantity_pieces: number; reason: string; note?: string }>();

  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;

  // Карта stage_id -> имя этапа по всем деталям сразу — та же, что уже
  // строит десктопная карточка партии (PartUnits.tsx), для истории.
  const stageNameById = new Map<number, string>();
  for (const p of partsQuery.data ?? []) for (const s of p.stages) stageNameById.set(s.id, s.name);
  const stageName = (id: number | null) => (id == null ? null : (stageNameById.get(id) ?? `#${id}`));

  // Следующий этап той же детали, куда партия переедет при переводе —
  // подсказка в форме, чтобы не переводить вслепую.
  const nextStageName = (u: PartUnit): string | null => {
    const part = partsQuery.data?.find((p) => p.id === u.part_id);
    if (!part) return null;
    const stages = [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order);
    const idx = stages.findIndex((s) => s.id === u.stage_id);
    if (idx === -1 || idx + 1 >= stages.length) return null;
    return stages[idx + 1].name;
  };

  const eventsQuery = useQuery({
    queryKey: ["part-unit-events", unit?.id],
    queryFn: () => listPartUnitEvents(unit!.id),
    enabled: !!unit,
  });

  const scanMutation = useMutation({
    mutationFn: (id: number) => getPartUnit(id),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
    },
    onError: () => message.error("Партия не найдена"),
  });

  useEffect(() => {
    const preselectId = (location.state as { unitId?: number } | null)?.unitId;
    if (preselectId) scanMutation.mutate(preselectId);
    // scanMutation.mutate стабилен между рендерами (react-query) — не в зависимостях намеренно
  }, [location.state]);

  const placeMutation = useMutation({
    mutationFn: (values: { location_code: string }) => placePartUnit(unit!.id, values.location_code),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
      placeForm.resetFields();
      message.success("Адрес сохранён");
    },
    onError: () => message.error("Не удалось разместить"),
  });

  const issueMutation = useMutation({
    mutationFn: () => issuePartUnit(unit!.id),
    onSuccess: (u) => {
      setUnit(u);
      message.success(`Выдана участку «${areaLabel(u.area ?? "")}»`);
    },
    onError: () => message.error("Не удалось выдать участку"),
  });

  const advanceMutation = useMutation({
    mutationFn: (values: { quantity_pieces: number }) => advancePartUnit(unit!.id, values.quantity_pieces),
    onSuccess: (u) => {
      setUnit(u);
      setAction(null);
      advanceForm.resetFields();
      qc.invalidateQueries({ queryKey: ["part-unit-events", u.id] });
      message.success(`Переведена на этап «${u.stage_name}»`);
    },
    onError: () => message.error("Не удалось перевести на следующий этап"),
  });

  const writeOffMutation = useMutation({
    mutationFn: (values: { quantity_pieces: number; reason: string; note?: string }) => writeOffPartUnit(unit!.id, values),
    onSuccess: (u) => {
      setUnit(u);
      setWriteOffOpen(false);
      writeOffForm.resetFields();
      qc.invalidateQueries({ queryKey: ["part-unit-events", u.id] });
      message.success("Партия списана");
    },
    onError: () => message.error("Не удалось списать"),
  });

  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;
  const reasonName = (code: string) => writeOffReasonsQuery.data?.find((r) => r.code === code)?.name ?? code;

  return (
    <Card>
      <Typography.Title level={4}>Карточка партии п/ф</Typography.Title>

      {!unit && (
        <Form form={scanForm} layout="vertical" onFinish={(v) => scanMutation.mutate(v.id)} style={{ marginTop: 16 }}>
          <Form.Item name="id" label="ID партии (по бирке/QR «ПФ…»)" rules={[{ required: true }]}>
            <InputNumber size="large" autoFocus style={{ width: "100%" }} placeholder="Введите ID или отсканируйте" />
          </Form.Item>
          <Space style={{ width: "100%" }}>
            <Button size="large" type="primary" htmlType="submit" loading={scanMutation.isPending}>
              Найти по ID
            </Button>
            <QrScanButton
              size="large"
              buttonText="Сканировать QR"
              onScan={(code) => {
                const parsedId = parseInt(code.replace(/\D/g, ""), 10);
                if (parsedId) scanMutation.mutate(parsedId);
                else message.error("QR не содержит числового ID партии");
              }}
            />
          </Space>
        </Form>
      )}

      {unit && (
        <>
          <Descriptions column={1} size="small" style={{ marginBottom: 16 }} bordered>
            <Descriptions.Item label="ID">№ {unit.id}</Descriptions.Item>
            <Descriptions.Item label="Деталь">{unit.part_name}</Descriptions.Item>
            <Descriptions.Item label="Количество">
              {unit.quantity_available} шт
              {unit.quantity_available !== unit.quantity_pieces && ` (из ${unit.quantity_pieces})`}
            </Descriptions.Item>
            <Descriptions.Item label="Этап">{unit.stage_name}</Descriptions.Item>
            <Descriptions.Item label="Статус">
              <Tag color={unit.status === "Выдан_участку" ? "green" : unit.status === "Списан" ? "red" : "blue"}>
                {statusLabels[unit.status] ?? unit.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Где сейчас">
              {unit.location_code ?? (unit.area ? areaLabel(unit.area) : "—")}
            </Descriptions.Item>
            {unit.parent_id && <Descriptions.Item label="Из партии">№ {unit.parent_id}</Descriptions.Item>}
            {unit.note && <Descriptions.Item label="Заметка">{unit.note}</Descriptions.Item>}
          </Descriptions>

          {!action && (
            <Space wrap size="middle" style={{ marginBottom: 16 }}>
              {unit.status === "На_хранении" && (
                <>
                  <Button size="large" type="primary" onClick={() => setAction("place")}>
                    Разместить
                  </Button>
                  <Button size="large" loading={issueMutation.isPending} onClick={() => issueMutation.mutate()}>
                    Выдать участку
                  </Button>
                </>
              )}
              {unit.status === "Выдан_участку" && (
                <Button size="large" type="primary" onClick={() => setAction("advance")}>
                  Перевести на следующий этап
                </Button>
              )}
              {unit.status !== "Списан" && (
                <Button size="large" danger onClick={() => setWriteOffOpen(true)}>
                  Списать
                </Button>
              )}
              <Button
                onClick={() => {
                  setUnit(null);
                  scanForm.resetFields();
                }}
              >
                Другая партия
              </Button>
            </Space>
          )}

          {action === "place" && (
            <Form form={placeForm} layout="vertical" onFinish={(v) => placeMutation.mutate(v)} style={{ marginTop: 16 }}>
              <Form.Item
                name="location_code"
                label="Адрес полки"
                rules={[{ required: true }]}
                initialValue={unit.location_code ?? undefined}
              >
                <Input placeholder="Например, ЗГ-1-01" autoFocus />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={placeMutation.isPending}>
                Сохранить адрес
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          {action === "advance" && (
            <Form
              form={advanceForm}
              layout="vertical"
              onFinish={(v) => advanceMutation.mutate(v)}
              style={{ marginTop: 16 }}
              initialValues={{ quantity_pieces: unit.quantity_available }}
            >
              {nextStageName(unit) ? (
                <Alert style={{ marginBottom: 16 }} type="info" showIcon message={`Следующий этап: «${nextStageName(unit)}»`} />
              ) : (
                <Alert
                  style={{ marginBottom: 16 }}
                  type="success"
                  showIcon
                  message="Это последний этап — партия будет отмечена как «Завершение»"
                />
              )}
              <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
                <InputNumber min={0.01} max={unit.quantity_available} step={1} style={{ width: "100%" }} autoFocus />
              </Form.Item>
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Меньше, чем в партии — переведётся только часть, остальное останется на текущем этапе.
              </Typography.Text>
              <Button type="primary" htmlType="submit" block loading={advanceMutation.isPending} style={{ marginTop: 12 }}>
                Перевести
              </Button>
              <Button block style={{ marginTop: 8 }} onClick={() => setAction(null)}>
                Отмена
              </Button>
            </Form>
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            История
          </Typography.Title>
          <List
            size="small"
            loading={eventsQuery.isLoading}
            dataSource={eventsQuery.data ?? []}
            locale={{ emptyText: "Событий пока нет" }}
            renderItem={(ev) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <span>
                    <Tag>{ev.event_type.replace(/_/g, " ")}</Tag>
                    {new Date(ev.occurred_at).toLocaleString("ru-RU")} — {userName(ev.user_id)}
                  </span>
                  {(ev.from_stage_id != null || ev.to_stage_id != null) && (
                    <Typography.Text type="secondary">
                      {stageName(ev.from_stage_id) ?? "—"} → {stageName(ev.to_stage_id) ?? "—"}
                    </Typography.Text>
                  )}
                  {(ev.from_cell || ev.to_cell) && (
                    <Typography.Text type="secondary">
                      {ev.from_cell ?? "—"} → {ev.to_cell ?? "—"}
                    </Typography.Text>
                  )}
                  {ev.write_off_reason && (
                    <Typography.Text type="secondary">
                      Причина: {reasonName(ev.write_off_reason)}
                      {ev.write_off_note ? ` — ${ev.write_off_note}` : ""}
                    </Typography.Text>
                  )}
                </Space>
              </List.Item>
            )}
          />
        </>
      )}

      <Modal
        title="Списать партию"
        open={writeOffOpen}
        onCancel={() => setWriteOffOpen(false)}
        onOk={() => writeOffForm.submit()}
        okButtonProps={{ danger: true, loading: writeOffMutation.isPending }}
        okText="Списать"
        destroyOnHidden
      >
        <Alert style={{ marginBottom: 16 }} type="warning" showIcon message="Отменить нельзя — используйте, если партия испорчена или физически отсутствует." />
        <Form
          form={writeOffForm}
          layout="vertical"
          onFinish={(v) => writeOffMutation.mutate(v)}
          initialValues={{ quantity_pieces: unit?.quantity_available }}
        >
          <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
            <InputNumber min={0.01} max={unit?.quantity_available} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
            <Select
              loading={writeOffReasonsQuery.isLoading}
              options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
              placeholder="Выберите причину"
            />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
