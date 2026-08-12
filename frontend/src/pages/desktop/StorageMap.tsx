import { useMemo, useState } from "react";
import {
  Card,
  Tabs,
  Table,
  Button,
  Tag,
  Popconfirm,
  Popover,
  Form,
  Input,
  Select,
  Modal,
  InputNumber,
  Space,
  Typography,
  Empty,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  createMacroZoneRule,
  createRack,
  deleteMacroZoneRule,
  getRackOccupancy,
  listMacroZoneRules,
  listRacks,
  updateRack,
  type MacroZoneRuleCreate,
  type Rack,
  type RackOccupancyCell,
  type RackUpdate,
} from "../../api/storage";
import DictAutoComplete from "../../components/DictAutoComplete";
import { skuLabel } from "../../api/units";
import { useAuth } from "../../auth/AuthContext";

/** Схема стеллажа (объединение "Настроек" по итогам продуктового разбора —
 * раньше "Настройки" отвечали и за стеллажи, и за пороги расчётов на одном
 * экране без общей темы). Рулонный стеллаж — одна ячейка на полку;
 * штрипсовый — сетка полка×ячейка. Число колонок берём из самих данных
 * (максимальный номер ячейки), не храним cells_per_strip_shelf на фронте
 * отдельно от бэкенда. */
function SchemeTab() {
  const navigate = useNavigate();
  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: listRacks });
  const activeRacks = (racksQuery.data ?? []).filter((r) => r.is_active);
  const [rackId, setRackId] = useState<number | null>(null);
  const selectedRack = activeRacks.find((r) => r.id === rackId) ?? activeRacks[0] ?? null;

  const occupancyQuery = useQuery({
    queryKey: ["rack-occupancy", selectedRack?.id],
    queryFn: () => getRackOccupancy(selectedRack!.id),
    enabled: !!selectedRack,
  });
  const rulesQuery = useQuery({
    queryKey: ["macro-zone-rules", selectedRack?.id],
    queryFn: () => listMacroZoneRules(selectedRack!.id),
    enabled: !!selectedRack,
  });

  const columns = useMemo(() => {
    if (!occupancyQuery.data) return 1;
    return Math.max(1, ...occupancyQuery.data.map((c) => c.cell ?? 1));
  }, [occupancyQuery.data]);

  const byShelf = useMemo(() => {
    const map = new Map<number, RackOccupancyCell[]>();
    for (const c of occupancyQuery.data ?? []) {
      const row = map.get(c.shelf) ?? [];
      row.push(c);
      map.set(c.shelf, row);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [occupancyQuery.data]);

  if (!racksQuery.isLoading && activeRacks.length === 0) {
    return <EmptyRacksHint />;
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Select
        style={{ width: 280 }}
        loading={racksQuery.isLoading}
        value={selectedRack?.id}
        onChange={setRackId}
        options={activeRacks.map((r) => ({ value: r.id, label: `${r.code} (${r.type === "roll" ? "рулонный" : "штрипсовый"}, ${r.shelf_count} полок)` }))}
      />

      {selectedRack && (
        <Card loading={occupancyQuery.isLoading}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `56px repeat(${columns}, 44px)`,
              gap: 6,
              alignItems: "center",
            }}
          >
            {byShelf.map(([shelf, cells]) => (
              <FragmentRow key={shelf} shelf={shelf} cells={cells} columns={columns} navigate={navigate} />
            ))}
          </div>
          <Space style={{ marginTop: 16 }} size="middle">
            <LegendSwatch color="#f0f0f0" border="#d9d9d9" label="свободно" />
            <LegendSwatch color="#e7f5ee" border="#1D9E75" label="занято" />
          </Space>
        </Card>
      )}

      {selectedRack && (
        <Card size="small" title={`Макрозонирование стеллажа ${selectedRack.code}`}>
          {rulesQuery.data && rulesQuery.data.length > 0 ? (
            <Space direction="vertical" size={4}>
              {rulesQuery.data.map((r) => (
                <Typography.Text key={r.id} type="secondary">
                  Полки {r.from_shelf}–{r.to_shelf}: {[r.material_id, r.color_id, r.thickness_id, r.manufacturer_id].every((v) => v == null) ? "любые позиции (буферная зона)" : "по правилу (см. «Управление»)"}
                </Typography.Text>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">Правил зонирования нет — весь стеллаж буферная зона.</Typography.Text>
          )}
        </Card>
      )}
    </Space>
  );
}

function FragmentRow({
  shelf,
  cells,
  columns,
  navigate,
}: {
  shelf: number;
  cells: RackOccupancyCell[];
  columns: number;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const byCell = new Map(cells.map((c) => [c.cell ?? 1, c]));
  return (
    <>
      <Typography.Text style={{ fontSize: 12, textAlign: "right" }} type="secondary">
        полка {shelf}
      </Typography.Text>
      {Array.from({ length: columns }, (_, i) => i + 1).map((col) => {
        const cellData = byCell.get(col);
        if (!cellData) return <div key={col} />;
        const occupied = !!cellData.unit;
        const content = occupied ? (
          <Space direction="vertical" size={2} style={{ maxWidth: 220 }}>
            <Typography.Text strong>№{cellData.unit!.id}</Typography.Text>
            <Typography.Text>{skuLabel(cellData.unit!.material_sku)}</Typography.Text>
            <Typography.Text type="secondary">
              {cellData.unit!.width_mm}×{cellData.unit!.length_m} м, {cellData.unit!.status.replace(/_/g, " ")}
            </Typography.Text>
            <Button size="small" onClick={() => navigate("/m/unit-card", { state: { unitId: cellData.unit!.id } })}>
              Открыть карточку единицы
            </Button>
          </Space>
        ) : (
          <Typography.Text type="secondary">{cellData.location_code} — свободно</Typography.Text>
        );
        return (
          <Popover key={col} content={content} title={cellData.location_code} trigger="click">
            <div
              style={{
                width: 44,
                height: 32,
                borderRadius: 5,
                cursor: "pointer",
                border: `1px solid ${occupied ? "#1D9E75" : "#d9d9d9"}`,
                background: occupied ? "#e7f5ee" : "#fafafa",
              }}
            />
          </Popover>
        );
      })}
    </>
  );
}

function LegendSwatch({ color, border, label }: { color: string; border: string; label: string }) {
  return (
    <Space size={6}>
      <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 4, background: color, border: `1px solid ${border}` }} />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
    </Space>
  );
}

function EmptyRacksHint() {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description="Стеллажи ещё не заведены — обратитесь к логисту (вкладка «Управление»)."
      style={{ margin: "32px 0" }}
    />
  );
}

function ManageTab() {
  const qc = useQueryClient();
  const [selectedRack, setSelectedRack] = useState<Rack | null>(null);
  const [rackModalOpen, setRackModalOpen] = useState(false);
  const [editingRack, setEditingRack] = useState<Rack | null>(null);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editRackForm] = Form.useForm<RackUpdate>();

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: listRacks });
  const rulesQuery = useQuery({
    queryKey: ["macro-zone-rules", selectedRack?.id],
    queryFn: () => listMacroZoneRules(selectedRack!.id),
    enabled: !!selectedRack,
  });

  const createRackMutation = useMutation({
    mutationFn: createRack,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["racks"] });
      setRackModalOpen(false);
      message.success("Стеллаж добавлен");
    },
  });
  const updateRackMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: RackUpdate }) => updateRack(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["racks"] });
      setEditingRack(null);
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить — код уже занят?"),
  });
  const createRuleMutation = useMutation({
    mutationFn: (payload: MacroZoneRuleCreate) => createMacroZoneRule(selectedRack!.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["macro-zone-rules", selectedRack?.id] });
      setRuleModalOpen(false);
      message.success("Правило добавлено");
    },
    onError: () => message.error("Не удалось создать правило — проверьте, что значения есть в справочниках"),
  });
  const deleteRuleMutation = useMutation({
    mutationFn: (ruleId: number) => deleteMacroZoneRule(selectedRack!.id, ruleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["macro-zone-rules", selectedRack?.id] });
      message.success("Правило удалено");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Стеллажи"
        extra={
          <Button type="primary" onClick={() => setRackModalOpen(true)}>
            Добавить стеллаж
          </Button>
        }
      >
        <Table
          rowKey="id"
          loading={racksQuery.isLoading}
          dataSource={racksQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Код", dataIndex: "code", render: (v, rack) => <a onClick={() => setSelectedRack(rack)}>{v}</a> },
            { title: "Тип", dataIndex: "type", render: (t: string) => (t === "roll" ? "Рулонный" : "Штрипсовый") },
            { title: "Число полок", dataIndex: "shelf_count" },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активен</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, rack) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingRack(rack);
                      editRackForm.setFieldsValue({ code: rack.code, type: rack.type, shelf_count: rack.shelf_count });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button
                    size="small"
                    onClick={() => updateRackMutation.mutate({ id: rack.id, payload: { is_active: !rack.is_active } })}
                  >
                    {rack.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {selectedRack && (
        <Card
          title={`Макрозонирование стеллажа ${selectedRack.code} (${selectedRack.shelf_count} полок)`}
          extra={
            <Button type="primary" onClick={() => setRuleModalOpen(true)}>
              Добавить правило
            </Button>
          }
        >
          <Table
            rowKey="id"
            loading={rulesQuery.isLoading}
            dataSource={rulesQuery.data ?? []}
            pagination={false}
            columns={[
              { title: "Полки", render: (_, r) => `${r.from_shelf}–${r.to_shelf}` },
              { title: "Материал", dataIndex: "material_id", render: (v) => v ?? "любой" },
              { title: "Цвет", dataIndex: "color_id", render: (v) => v ?? "любой" },
              { title: "Толщина", dataIndex: "thickness_id", render: (v) => v ?? "любая" },
              { title: "Производитель", dataIndex: "manufacturer_id", render: (v) => v ?? "любой" },
              {
                title: "",
                render: (_, rule) => (
                  <Popconfirm title="Удалить правило?" onConfirm={() => deleteRuleMutation.mutate(rule.id)}>
                    <Button size="small" danger>
                      Удалить
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal title="Новый стеллаж" open={rackModalOpen} onCancel={() => setRackModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v) => createRackMutation.mutate(v)}>
          <Form.Item name="code" label="Код (например, Р-3 или Ш-2)" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true }]} initialValue="roll">
            <Select
              options={[
                { value: "roll", label: "Рулонный" },
                { value: "strip", label: "Штрипсовый" },
              ]}
            />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createRackMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Изменить стеллаж ${editingRack?.code ?? ""}`} open={!!editingRack} onCancel={() => setEditingRack(null)} footer={null} destroyOnHidden>
        <Form form={editRackForm} layout="vertical" onFinish={(v) => editingRack && updateRackMutation.mutate({ id: editingRack.id, payload: v })}>
          <Form.Item name="code" label="Код" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "roll", label: "Рулонный" },
                { value: "strip", label: "Штрипсовый" },
              ]}
            />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={updateRackMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>

      <Modal title="Новое правило зонирования" open={ruleModalOpen} onCancel={() => setRuleModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v) => createRuleMutation.mutate(v)}>
          <Form.Item name="from_shelf" label="От полки" rules={[{ required: true }]}>
            <InputNumber min={1} max={selectedRack?.shelf_count} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="to_shelf" label="До полки" rules={[{ required: true }]}>
            <InputNumber min={1} max={selectedRack?.shelf_count} style={{ width: "100%" }} />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Пустое поле = «любое значение». Значения должны уже существовать в справочниках (заводятся при приёмке).
          </Typography.Paragraph>
          <Form.Item name="material" label="Материал">
            <DictAutoComplete kind="materials" placeholder="ПВХ плёнка" />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <DictAutoComplete kind="colors" placeholder="Дуб беленый" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм">
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="manufacturer" label="Производитель">
            <DictAutoComplete kind="manufacturers" placeholder="Классен" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createRuleMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

export default function StorageMap() {
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("storage.manage");

  return (
    <Card>
      <Typography.Title level={4}>Стеллажи</Typography.Title>
      <Tabs
        items={[
          { key: "scheme", label: "Схема", children: <SchemeTab /> },
          ...(canManage ? [{ key: "manage", label: "Управление", children: <ManageTab /> }] : []),
        ]}
      />
    </Card>
  );
}
