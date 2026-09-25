import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";
import { apiClient } from "../../api/client";
import { createRack, listWarehouses } from "../../api/storage";
import { createPartRack } from "../../api/partStorage";

interface Place {
  kind: "plenka" | "pf";
  id: number;
  code: string;
  type_label: string;
  warehouse: string | null;
  shelf_count: number;
  capacity_per_shelf: number | null;
  is_active: boolean;
  lots: number;
  shelves_used: number;
}

interface Cell {
  shelf: number;
  location_code: string;
  capacity: number | null;
  lots: { lot_id: number; item_id: number | null; item_name: string; qty: number; unit: string; detail: string | null; status: string }[];
}

const listPlaces = async (): Promise<Place[]> => (await apiClient.get<Place[]>("/storage-places")).data;
const setPlaceActive = async (kind: string, id: number, isActive: boolean): Promise<Place> =>
  (await apiClient.patch<Place>(`/storage-places/${kind}/${id}`, { is_active: isActive })).data;
const deletePlace = async (kind: string, id: number): Promise<void> => {
  await apiClient.delete(`/storage-places/${kind}/${id}`);
};
const listCells = async (kind: string, id: number): Promise<Cell[]> => (await apiClient.get<Cell[]>(`/storage-places/${kind}/${id}/cells`)).data;

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange" };

/** Места хранения (этап 5 единой модели, слой 3) — стеллажи плёнки и п/ф
 * одним справочником: вид, склад, загрузка; по раскрытию — карта полок с
 * тем, что на каждой. Код стеллажа уникален для всех видов. Размещение и
 * рабочие экраны кладовщика — прежние. */
export default function StoragePlaces() {
  const { user } = useAuth();
  const can = (c: string) => !!user?.is_superuser || !!user?.permissions.includes(c);
  const canFilm = can("storage.manage");
  const canPf = can("part_storage.manage");
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const placesQuery = useQuery({ queryKey: ["storage-places"], queryFn: listPlaces });
  const qc = useQueryClient();
  const canEdit = (p: Place) => (p.kind === "plenka" ? canFilm : canPf);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["storage-places"] });
    qc.invalidateQueries({ queryKey: ["racks"] });
    qc.invalidateQueries({ queryKey: ["part-racks"] });
  };
  const activeMutation = useMutation({
    mutationFn: (v: { p: Place; active: boolean }) => setPlaceActive(v.p.kind, v.p.id, v.active),
    onSuccess: (_, v) => {
      invalidate();
      message.success(v.active ? `«${v.p.code}» восстановлен` : `«${v.p.code}» в архиве`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить стеллаж")),
  });
  const deleteMutation = useMutation({
    mutationFn: (p: Place) => deletePlace(p.kind, p.id),
    onSuccess: (_, p) => {
      invalidate();
      message.success(`«${p.code}» удалён`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить стеллаж")),
  });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (placesQuery.data ?? []).filter(
      (p) => (kind === "all" || p.kind === kind) && (showArchived || p.is_active) && (!needle || p.code.toLowerCase().includes(needle)),
    );
  }, [placesQuery.data, kind, q, showArchived]);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Места хранения"
        extra={
          (canFilm || canPf) && (
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              + Стеллаж
            </Button>
          )
        }
      >
        <Typography.Paragraph type="secondary">
          Все стеллажи — плёнки и п/ф — в одном справочнике. Адрес — «код-полка» (например, «Р-3-07»), код стеллажа
          уникален для любого вида. Раскройте строку — карта полок: что и сколько лежит на каждой.
        </Typography.Paragraph>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as string)}
            options={[
              { label: "Все", value: "all" },
              { label: "Плёнка", value: "plenka" },
              { label: "П/ф", value: "pf" },
            ]}
          />
          <Input.Search allowClear placeholder="Код стеллажа" style={{ width: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
            С архивными
          </Checkbox>
        </Space>
      </Card>
      <ResponsiveTable<Place>
        tableKey="storage-places"
        lockedColumns={["Стеллаж"]}
        size="small"
        rowKey={(p) => `${p.kind}-${p.id}`}
        loading={placesQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        expandable={{ expandedRowRender: (p) => <PlaceCells place={p} /> }}
        columns={[
          { title: "Стеллаж", render: (_, p) => <b>{p.code}</b> },
          { title: "Вид", render: (_, p) => <Tag color={KIND_COLOR[p.kind]}>{p.type_label}</Tag> },
          { title: "Склад", render: (_, p) => p.warehouse ?? "—" },
          { title: "Полок", dataIndex: "shelf_count" },
          {
            title: "Занято полок",
            render: (_, p) => (
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {p.shelves_used} из {p.shelf_count}
              </span>
            ),
          },
          { title: "Партий", dataIndex: "lots" },
          { title: "Статус", render: (_, p) => (p.is_active ? <Tag color="green">активен</Tag> : <Tag>архив</Tag>) },
          {
            title: "",
            render: (_, p) =>
              canEdit(p) && (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  {p.is_active ? (
                    <Tooltip title={p.lots > 0 ? "Сначала переместите партии с этого стеллажа" : undefined}>
                      <Button size="small" disabled={p.lots > 0} onClick={() => activeMutation.mutate({ p, active: false })}>
                        В архив
                      </Button>
                    </Tooltip>
                  ) : (
                    <Button size="small" onClick={() => activeMutation.mutate({ p, active: true })}>
                      Восстановить
                    </Button>
                  )}
                  <Popconfirm
                    title={`Удалить стеллаж «${p.code}»?`}
                    description="Можно только если им никогда не пользовались; иначе — архив."
                    okText="Удалить"
                    cancelText="Отмена"
                    onConfirm={() => deleteMutation.mutate(p)}
                  >
                    <Button size="small" danger disabled={p.lots > 0}>
                      Удалить
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />
      {createOpen && <CreatePlaceModal canFilm={canFilm} canPf={canPf} onClose={() => setCreateOpen(false)} />}
    </Space>
  );
}

function PlaceCells({ place }: { place: Place }) {
  const navigate = useNavigate();
  const cellsQuery = useQuery({ queryKey: ["storage-place-cells", place.kind, place.id], queryFn: () => listCells(place.kind, place.id) });
  if (cellsQuery.isLoading) return <Spin />;
  const cells = cellsQuery.data ?? [];
  if (cells.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет полок" />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
      {cells.map((c) => {
        const full = c.capacity != null && c.lots.length >= c.capacity;
        return (
          <div
            key={c.shelf}
            style={{
              border: "1px solid var(--ant-color-border, #e5e5e5)",
              borderRadius: 6,
              padding: 8,
              background: c.lots.length === 0 ? "transparent" : full ? "rgba(250, 140, 22, 0.08)" : "rgba(22, 119, 255, 0.05)",
            }}
          >
            <Space style={{ justifyContent: "space-between", width: "100%" }}>
              <Typography.Text strong>{c.location_code}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {c.lots.length}
                {c.capacity != null ? ` / ${c.capacity}` : ""}
              </Typography.Text>
            </Space>
            {c.lots.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                свободна
              </Typography.Text>
            ) : (
              <Space direction="vertical" size={0} style={{ width: "100%" }}>
                {c.lots.slice(0, 4).map((l) => (
                  <Tooltip key={l.lot_id} title={`№${l.lot_id} · ${l.status}${l.detail ? ` · ${l.detail}` : ""}`}>
                    <a style={{ fontSize: 12 }} onClick={() => l.item_id && navigate(`/item/${l.item_id}?tab=stock`)}>
                      {l.item_name} — {l.qty} {l.unit}
                    </a>
                  </Tooltip>
                ))}
                {c.lots.length > 4 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    … ещё {c.lots.length - 4}
                  </Typography.Text>
                )}
              </Space>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CreatePlaceModal({ canFilm, canPf, onClose }: { canFilm: boolean; canPf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"roll" | "strip" | "pf">(canFilm ? "roll" : "pf");
  const [code, setCode] = useState("");
  const [shelves, setShelves] = useState<number | null>(10);
  const [capacity, setCapacity] = useState<number | null>(10);
  const [warehouseId, setWarehouseId] = useState<number | undefined>();
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses, enabled: canFilm });
  const mutation = useMutation({
    mutationFn: () =>
      kind === "pf"
        ? createPartRack({ code: code.trim(), shelf_count: shelves as number })
        : createRack({
            code: code.trim(),
            type: kind,
            shelf_count: shelves as number,
            strip_capacity: kind === "strip" ? capacity : null,
            warehouse_id: warehouseId as number,
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["storage-places"] });
      qc.invalidateQueries({ queryKey: ["racks"] });
      qc.invalidateQueries({ queryKey: ["part-racks"] });
      message.success("Стеллаж добавлен");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить стеллаж")),
  });
  const invalid = !code.trim() || !shelves || (kind !== "pf" && !warehouseId) || (kind === "strip" && !capacity);

  return (
    <Modal
      open
      title="Новый стеллаж"
      okText="Добавить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: invalid, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Form layout="vertical">
        <Form.Item label="Вид">
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as "roll" | "strip" | "pf")}
            options={[
              ...(canFilm
                ? [
                    { label: "Плёнка: рулонный", value: "roll" },
                    { label: "Плёнка: штрипсовый", value: "strip" },
                  ]
                : []),
              ...(canPf ? [{ label: "П/ф", value: "pf" }] : []),
            ]}
          />
        </Form.Item>
        <Form.Item label="Код" required extra="Адрес полки будет «код-01», «код-02»…">
          <Input value={code} placeholder="Р-9" onChange={(e) => setCode(e.target.value)} />
        </Form.Item>
        <Space size={12} wrap>
          <Form.Item label="Полок" required>
            <InputNumber min={1} value={shelves} onChange={setShelves} />
          </Form.Item>
          {kind === "strip" && (
            <Form.Item label="Штрипсов на полку" required>
              <InputNumber min={1} value={capacity} onChange={setCapacity} />
            </Form.Item>
          )}
          {kind !== "pf" && (
            <Form.Item label="Склад" required>
              <Select
                style={{ width: 200 }}
                value={warehouseId}
                onChange={setWarehouseId}
                options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
              />
            </Form.Item>
          )}
        </Space>
      </Form>
    </Modal>
  );
}
