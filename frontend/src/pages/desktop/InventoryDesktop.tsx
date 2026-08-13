import { useMemo, useState } from "react";
import {
  Card,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Select,
  Space,
  Statistic,
  Row,
  Col,
  List,
  Divider,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listSessions,
  startSession,
  closeSession,
  resolveShortage,
  type InventoryScopeType,
  type InventorySession,
  type CloseSessionResult,
} from "../../api/inventory";
import { listRacks } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import { skuLabel } from "../../api/units";
import { listUsers } from "../../api/users";

const scopeOptions = [
  { value: "rack", label: "Стеллаж" },
  { value: "warehouse", label: "Весь склад" },
  { value: "material_sku", label: "Позиция материала" },
];

export default function InventoryDesktop() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [scopeType, setScopeType] = useState<InventoryScopeType>("rack");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [closeResult, setCloseResult] = useState<CloseSessionResult | null>(null);

  const sessionsQuery = useQuery({ queryKey: ["inventory-sessions"], queryFn: listSessions });
  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: () => listRacks() });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });

  const participantNames = (ids: number[]) =>
    (usersQuery.data ?? [])
      .filter((u) => ids.includes(u.id))
      .map((u) => u.full_name)
      .join(", ");

  const rackLabel = useMemo(() => {
    const map = new Map((racksQuery.data ?? []).map((r) => [r.id, r.code]));
    return (id: number | null) => (id != null ? (map.get(id) ?? `#${id}`) : "");
  }, [racksQuery.data]);

  const skuLabelById = useMemo(() => {
    const map = new Map((skusQuery.data ?? []).map((s) => [s.id, skuLabel(s)]));
    return (id: number | null) => (id != null ? (map.get(id) ?? `#${id}`) : "");
  }, [skusQuery.data]);

  const scopeLabel = (s: InventorySession) => {
    if (s.scope_type === "warehouse") return "Весь склад";
    if (s.scope_type === "rack") return `Стеллаж ${rackLabel(s.scope_ref_id)}`;
    return `Позиция ${skuLabelById(s.scope_ref_id)}`;
  };

  const startMutation = useMutation({
    mutationFn: startSession,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory-sessions"] });
      setCreateOpen(false);
      message.success("Сессия открыта — сканирование проводится с мобильного экрана «Инвентаризация»");
    },
    onError: () => message.error("Не удалось открыть сессию"),
  });

  const closeMutation = useMutation({
    mutationFn: (id: number) => closeSession(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["inventory-sessions"] });
      setCloseResult(result);
      message.success("Сессия закрыта");
    },
    onError: () => message.error("Не удалось закрыть сессию"),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ sessionId, unitId, action }: { sessionId: number; unitId: number; action: "spisat" | "vernut_v_poisk" }) =>
      resolveShortage(sessionId, unitId, action),
    onSuccess: (_, vars) => {
      setCloseResult((r) => (r ? { ...r, shortages: r.shortages.filter((s) => s.id !== vars.unitId) } : r));
      message.success("Решение сохранено");
    },
  });

  const selected = (sessionsQuery.data ?? []).find((s) => s.id === selectedId) ?? null;

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Инвентаризация — сессии"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Начать сессию
          </Button>
        }
      >
        <Table<InventorySession>
          rowKey="id"
          loading={sessionsQuery.isLoading}
          dataSource={sessionsQuery.data ?? []}
          scroll={{ x: "max-content" }}
          onRow={(s) => ({
            onClick: () => {
              setSelectedId(s.id);
              setCloseResult(null);
            },
          })}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: "№", dataIndex: "id", width: 60 },
            { title: "Область", render: (_, s) => scopeLabel(s) },
            {
              title: "Статус",
              dataIndex: "status",
              render: (v: string) =>
                v === "in_progress" ? <Tag color="blue">В процессе</Tag> : <Tag>Закрыта</Tag>,
            },
            { title: "Ожидалось", dataIndex: "expected_count" },
            { title: "Отсканировано", dataIndex: "scanned_count" },
            { title: "Участники", render: (_, s) => participantNames(s.participant_ids) || "—" },
            { title: "Начата", dataIndex: "started_at", render: (v: string) => new Date(v).toLocaleString("ru-RU") },
            {
              title: "Закрыта",
              dataIndex: "closed_at",
              render: (v: string | null) => (v ? new Date(v).toLocaleString("ru-RU") : "—"),
            },
          ]}
        />
      </Card>

      {selected && (
        <Card title={`Сессия №${selected.id} — ${scopeLabel(selected)}`}>
          {participantNames(selected.participant_ids) && (
            <Typography.Paragraph type="secondary">
              Участники: {participantNames(selected.participant_ids)}
            </Typography.Paragraph>
          )}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <Statistic title="Ожидалось" value={selected.expected_count} />
            </Col>
            <Col span={6}>
              <Statistic title="Отсканировано" value={selected.scanned_count} />
            </Col>
            <Col span={6}>
              <Statistic
                title="Статус"
                valueRender={() =>
                  selected.status === "in_progress" ? <Tag color="blue">В процессе</Tag> : <Tag>Закрыта</Tag>
                }
              />
            </Col>
          </Row>

          {selected.status === "in_progress" && (
            <Typography.Paragraph type="secondary">
              Сканирование ведётся с мобильного экрана «Инвентаризация» на складе. Отсюда сессию можно только
              закрыть — обычно после того, как все ожидаемые адреса обойдены.
            </Typography.Paragraph>
          )}

          {selected.status === "in_progress" && (
            <Button danger loading={closeMutation.isPending} onClick={() => closeMutation.mutate(selected.id)}>
              Закрыть сессию
            </Button>
          )}

          {(closeResult?.session.id === selected.id || selected.status === "closed") && closeResult && (
            <>
              <Divider>Итоги закрытия</Divider>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}>
                  <Statistic title="Подтверждено" value={closeResult.confirmed_count} />
                </Col>
                <Col span={6}>
                  <Statistic title="Перемещено" value={closeResult.moved_count} />
                </Col>
                <Col span={6}>
                  <Statistic title="Излишков" value={closeResult.surplus_count} />
                </Col>
                <Col span={6}>
                  <Statistic title="Недостач" value={closeResult.shortages.length} valueStyle={{ color: "#C97A2B" }} />
                </Col>
              </Row>
              {closeResult.shortages.length > 0 && (
                <>
                  <Divider>Недостачи — решение по каждой</Divider>
                  <List
                    dataSource={closeResult.shortages}
                    renderItem={(s) => (
                      <List.Item
                        actions={[
                          <Button
                            key="write-off"
                            danger
                            size="small"
                            onClick={() => resolveMutation.mutate({ sessionId: selected.id, unitId: s.id, action: "spisat" })}
                          >
                            Списать
                          </Button>,
                          <Button
                            key="keep"
                            size="small"
                            onClick={() =>
                              resolveMutation.mutate({ sessionId: selected.id, unitId: s.id, action: "vernut_v_poisk" })
                            }
                          >
                            Вернуть в поиск
                          </Button>,
                        ]}
                      >
                        № {s.id} — {s.width_mm} мм × {s.length_m} м, числилась в {s.location_code}
                      </List.Item>
                    )}
                  />
                </>
              )}
            </>
          )}
        </Card>
      )}

      <Modal title="Новая сессия инвентаризации" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form
          layout="vertical"
          onFinish={(v) =>
            startMutation.mutate({
              scope_type: v.scope_type,
              scope_ref_id: v.scope_ref_id,
              participant_ids: v.participant_ids,
            })
          }
        >
          <Form.Item name="scope_type" label="Область" rules={[{ required: true }]} initialValue="rack">
            <Select options={scopeOptions} onChange={(v) => setScopeType(v)} />
          </Form.Item>
          {scopeType === "rack" && (
            <Form.Item name="scope_ref_id" label="Стеллаж" rules={[{ required: true }]}>
              <Select loading={racksQuery.isLoading} options={(racksQuery.data ?? []).map((r) => ({ value: r.id, label: r.code }))} />
            </Form.Item>
          )}
          {scopeType === "material_sku" && (
            <Form.Item name="scope_ref_id" label="Позиция материала" rules={[{ required: true }]}>
              <Select
                loading={skusQuery.isLoading}
                options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
              />
            </Form.Item>
          )}
          <Form.Item name="participant_ids" label="Участники (кроме вас — вы добавляетесь автоматически)">
            <Select
              mode="multiple"
              loading={usersQuery.isLoading}
              options={(usersQuery.data ?? []).map((u) => ({ value: u.id, label: u.full_name }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={startMutation.isPending}>
            Открыть сессию
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
