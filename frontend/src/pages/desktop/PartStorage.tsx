import { useMemo, useState } from "react";
import { Card, Space, Typography, Button, Modal, Form, Input, InputNumber, Tag, message } from "antd";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { createPartRack, getPartRackOccupancy, listPartRacks, type PartRackOccupancyCell } from "../../api/partStorage";
import { useAuth } from "../../auth/AuthContext";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Стеллажи п/ф (раздел про адресное хранение деталей) — упрощённая
 * параллель StorageMap.tsx: без типа (рулонный/штрипсовый), склада и
 * макрозон/лимитов занятости — п/ф живёт в одном цехе, полка просто
 * адрес (см. BDK_Учет_ПФ_план.md). Размещение партии на полку — действие
 * в PartUnits.tsx («Учёт п/ф»), не здесь: этот экран только показывает
 * схему стеллажей, чтобы найти свободное место или конкретную партию. */
export default function PartStorage() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("part_storage.manage");
  const qc = useQueryClient();
  const [rackId, setRackId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ code: string; shelf_count: number }>();

  const racksQuery = useQuery({ queryKey: ["part-racks"], queryFn: () => listPartRacks() });
  const activeRacks = (racksQuery.data ?? []).filter((r) => r.is_active);
  const selectedRack = activeRacks.find((r) => r.id === rackId) ?? activeRacks[0] ?? null;

  const occupancyByRack = useQueries({
    queries: activeRacks.map((r) => ({ queryKey: ["part-rack-occupancy", r.id], queryFn: () => getPartRackOccupancy(r.id) })),
  });
  const occupancyForSelected = occupancyByRack[activeRacks.findIndex((r) => r.id === selectedRack?.id)]?.data;

  const byShelf = useMemo(() => {
    const map = new Map<number, PartRackOccupancyCell>();
    for (const c of occupancyForSelected ?? []) map.set(c.shelf, c);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [occupancyForSelected]);

  const createMutation = useMutation({
    mutationFn: createPartRack,
    onSuccess: (rack) => {
      qc.invalidateQueries({ queryKey: ["part-racks"] });
      setCreateOpen(false);
      form.resetFields();
      setRackId(rack.id);
      message.success("Стеллаж добавлен");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить стеллаж — код уже занят?")),
  });

  if (!racksQuery.isLoading && activeRacks.length === 0) {
    return (
      <Card>
        <Typography.Title level={4}>Стеллажи п/ф</Typography.Title>
        <Typography.Paragraph type="secondary">Стеллажи ещё не заведены.</Typography.Paragraph>
        {canManage && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + Добавить стеллаж
          </Button>
        )}
        {createRackModal()}
      </Card>
    );
  }

  function createRackModal() {
    return (
      <Modal title="Новый стеллаж п/ф" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => createMutation.mutate(v)}>
          <Form.Item name="code" label="Код (например, ЗГ-1)" rules={[{ required: true }]}>
            <Input placeholder="ЗГ-1" />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    );
  }

  return (
    <Card>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Стеллажи п/ф
        </Typography.Title>
        {canManage && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + Добавить стеллаж
          </Button>
        )}
      </Space>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 720, overflowY: "auto" }}>
          {activeRacks.map((rack, idx) => {
            const occ = occupancyByRack[idx]?.data;
            const total = occ?.length ?? rack.shelf_count;
            const used = occ?.filter((c) => c.units.length > 0).length ?? 0;
            const isSelected = selectedRack?.id === rack.id;
            return (
              <Card
                key={rack.id}
                size="small"
                onClick={() => setRackId(rack.id)}
                style={{
                  cursor: "pointer",
                  borderColor: isSelected ? "#C97A2B" : undefined,
                  boxShadow: isSelected ? "0 0 0 2px #FBF0E3" : undefined,
                }}
              >
                <Typography.Text strong>{rack.code}</Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {used} из {total} полок занято
                  </Typography.Text>
                </div>
              </Card>
            );
          })}
        </div>

        {selectedRack ? (
          <Card>
            <Typography.Title level={5} style={{ marginBottom: 12 }}>
              Стеллаж {selectedRack.code} — {selectedRack.shelf_count} полок
            </Typography.Title>
            <div style={{ background: "#fff", border: "1px solid #DEDEDA", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {byShelf.map(([shelf, cell]) => {
                  const occupied = cell.units.length > 0;
                  return (
                    <div key={shelf} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Typography.Text style={{ width: 56, fontSize: 12, textAlign: "right", flexShrink: 0 }} type="secondary">
                        полка {shelf}
                      </Typography.Text>
                      <div
                        style={{
                          flex: "1 1 0%",
                          minWidth: 0,
                          borderRadius: 8,
                          border: `1px solid ${occupied ? "#1D9E75" : "#d9d9d9"}`,
                          background: occupied ? "#e7f5ee" : "#fafafa",
                          padding: "7px 14px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          minHeight: 32,
                        }}
                      >
                        {occupied ? (
                          cell.units.map((u) => (
                            <div key={u.id} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center" }}>
                              <Typography.Text strong>№{u.id}</Typography.Text>
                              <Typography.Text>{u.part_name}</Typography.Text>
                              <Typography.Text type="secondary">{u.quantity_pieces} шт</Typography.Text>
                              <Tag style={{ margin: 0 }}>{u.stage_name}</Tag>
                            </div>
                          ))
                        ) : (
                          <Typography.Text type="secondary">{cell.location_code} — свободно</Typography.Text>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        ) : (
          <Card style={{ textAlign: "center", padding: "24px 8px", color: "#8A8C99" }}>Выберите стеллаж слева.</Card>
        )}
      </div>

      {createRackModal()}
    </Card>
  );
}
