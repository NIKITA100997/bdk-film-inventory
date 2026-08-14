import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Tabs,
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
  Progress,
  message,
} from "antd";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  createMacroZoneRule,
  createRack,
  createWarehouse,
  deleteMacroZoneRule,
  getRackOccupancy,
  listMacroZoneRules,
  listRacks,
  listWarehouses,
  suggestLocation,
  updateRack,
  updateWarehouse,
  type MacroZoneRule,
  type MacroZoneRuleCreate,
  type Rack,
  type RackOccupancyCell,
  type RackType,
  type RackUpdate,
  type Warehouse,
  type WarehouseUpdate,
} from "../../api/storage";
import { listColors, listManufacturers, listMaterials, listThicknesses } from "../../api/dictionaries";
import DictAutoComplete from "../../components/DictAutoComplete";
import ResponsiveTable from "../../components/ResponsiveTable";
import { placeUnit, searchUnits, skuLabel, type MaterialUnit } from "../../api/units";
import { useAuth } from "../../auth/AuthContext";

const typeLabels: Record<RackType, string> = { roll: "рулонный", strip: "штрипсовый" };

// Кросс-ссылка "В остатках" (раздел про организацию меню — Остатки и
// Стеллажи не мержим в один экран, разные оси, но связываем переходом) —
// та же форма state, что MaterialCard уже принимает от других экранов.
const skuToPrefill = (sku: { material: { name: string }; color: { name: string }; thickness: { value_mm: number } }) => ({
  material: sku.material.name,
  color: sku.color.name,
  thickness: sku.thickness.value_mm,
});

/** Стеллажи и ячейки — раздел про склад: схема и правила зонирования
 * объединены в одно окно (раньше были на отдельных вкладках "Схема" и
 * "Управление", стеллаж приходилось выбирать заново в каждой). Список
 * стеллажей слева сразу показывает занятость и наличие правил, справа —
 * схема и правила выбранного стеллажа вместе, редактирование тут же. */
function RacksConsole() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("storage.manage");

  const [typeFilter, setTypeFilter] = useState<RackType | "all">("all");
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [rackId, setRackId] = useState<number | null>(null);
  const [rackModalOpen, setRackModalOpen] = useState(false);
  const [editingRack, setEditingRack] = useState<Rack | null>(null);
  const [editRackForm] = Form.useForm<RackUpdate>();
  const [ruleModalOpen, setRuleModalOpen] = useState(false);

  // Кросс-ссылка "На стеллаже" из Остатков (раздел про организацию меню)
  // — приходим сюда уже с известным стеллажом, фильтры сбрасываем, чтобы
  // он точно попал в видимый список.
  useEffect(() => {
    const incomingRackId = (location.state as { rackId?: number } | null)?.rackId;
    if (incomingRackId) {
      setRackId(incomingRackId);
      setTypeFilter("all");
      setWarehouseId(null);
    }
  }, [location.state]);

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: () => listRacks() });
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const materialsQuery = useQuery({ queryKey: ["materials"], queryFn: listMaterials });
  const colorsQuery = useQuery({ queryKey: ["colors"], queryFn: listColors });
  const manufacturersQuery = useQuery({ queryKey: ["manufacturers"], queryFn: listManufacturers });
  const thicknessesQuery = useQuery({ queryKey: ["thicknesses"], queryFn: listThicknesses });
  const activeWarehouses = (warehousesQuery.data ?? []).filter((w) => w.is_active);

  const materialName = (id: number | null) => (id == null ? "любой" : materialsQuery.data?.find((m) => m.id === id)?.name ?? `#${id}`);
  const colorName = (id: number | null) => (id == null ? "любой" : colorsQuery.data?.find((c) => c.id === id)?.name ?? `#${id}`);
  const manufacturerName = (id: number | null) => (id == null ? "любой" : manufacturersQuery.data?.find((m) => m.id === id)?.name ?? `#${id}`);
  const thicknessName = (id: number | null) => {
    if (id == null) return "любая";
    const found = thicknessesQuery.data?.find((t) => t.id === id);
    return found ? `${found.value_mm} мм` : `#${id}`;
  };

  const allActiveRacks = (racksQuery.data ?? []).filter((r) => r.is_active);
  const visibleRacks = allActiveRacks.filter(
    (r) => (typeFilter === "all" || r.type === typeFilter) && (!warehouseId || r.warehouse_id === warehouseId),
  );
  const rollCount = allActiveRacks.filter((r) => r.type === "roll").length;
  const stripCount = allActiveRacks.filter((r) => r.type === "strip").length;

  const selectedRack = visibleRacks.find((r) => r.id === rackId) ?? visibleRacks[0] ?? null;

  // Занятость и число правил для каждой видимой строки списка — раздел
  // про информативность списка: видно, что требует внимания, не заходя в
  // каждый стеллаж по отдельности.
  const occupancyByRack = useQueries({
    queries: visibleRacks.map((r) => ({
      queryKey: ["rack-occupancy", r.id],
      queryFn: () => getRackOccupancy(r.id),
    })),
  });
  const rulesByRack = useQueries({
    queries: visibleRacks.map((r) => ({
      queryKey: ["macro-zone-rules", r.id],
      queryFn: () => listMacroZoneRules(r.id),
    })),
  });

  const occupancyForSelected = occupancyByRack[visibleRacks.findIndex((r) => r.id === selectedRack?.id)]?.data;
  const rulesForSelected = rulesByRack[visibleRacks.findIndex((r) => r.id === selectedRack?.id)]?.data;

  const columns = useMemo(() => {
    if (!occupancyForSelected) return 1;
    return Math.max(1, ...occupancyForSelected.map((c) => c.cell ?? 1));
  }, [occupancyForSelected]);

  const byShelf = useMemo(() => {
    const map = new Map<number, RackOccupancyCell[]>();
    for (const c of occupancyForSelected ?? []) {
      const row = map.get(c.shelf) ?? [];
      row.push(c);
      map.set(c.shelf, row);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [occupancyForSelected]);

  const createRackMutation = useMutation({
    mutationFn: createRack,
    onSuccess: (rack) => {
      qc.invalidateQueries({ queryKey: ["racks"] });
      setRackModalOpen(false);
      setRackId(rack.id);
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

  if (!racksQuery.isLoading && allActiveRacks.length === 0) {
    return canManage ? (
      <>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Стеллажи ещё не заведены" style={{ margin: "32px 0" }}>
          <Button type="primary" onClick={() => setRackModalOpen(true)}>
            Добавить стеллаж
          </Button>
        </Empty>
        {rackFormModal()}
      </>
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Стеллажи ещё не заведены — обратитесь к логисту." style={{ margin: "32px 0" }} />
    );
  }

  function rackFormModal() {
    return (
      <Modal title="Новый стеллаж" open={rackModalOpen} onCancel={() => setRackModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" onFinish={(v) => createRackMutation.mutate(v)}>
          <Form.Item name="code" label="Код (например, Р-3 или Ш-2)" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true }]} initialValue="roll">
            <Select options={[{ value: "roll", label: "Рулонный" }, { value: "strip", label: "Штрипсовый" }]} />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Склад" rules={[{ required: true }]}>
            <Select options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createRackMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <UnplacedUnitsCard />
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Space>
          <Space.Compact>
            <Button type={typeFilter === "all" ? "primary" : "default"} onClick={() => setTypeFilter("all")}>
              Все ({allActiveRacks.length})
            </Button>
            <Button type={typeFilter === "roll" ? "primary" : "default"} onClick={() => setTypeFilter("roll")}>
              Рулонные ({rollCount})
            </Button>
            <Button type={typeFilter === "strip" ? "primary" : "default"} onClick={() => setTypeFilter("strip")}>
              Штрипсовые ({stripCount})
            </Button>
          </Space.Compact>
          {activeWarehouses.length > 1 && (
            <Select
              style={{ width: 200 }}
              placeholder="Склад — все"
              allowClear
              value={warehouseId ?? undefined}
              onChange={(v) => setWarehouseId(v ?? null)}
              options={activeWarehouses.map((w) => ({ value: w.id, label: w.name }))}
            />
          )}
        </Space>
        {canManage && (
          <Button type="primary" onClick={() => setRackModalOpen(true)}>
            + Добавить стеллаж
          </Button>
        )}
      </Space>

      {/* grid auto-fit/minmax вместо фиксированной колонки "340px 1fr" — на
          узком планшетном портрете 340px левой колонки почти не оставляли
          места правой панели деталей стеллажа (заголовок и текст в ней
          сжимались в тесную полоску). auto-fit с порогом 300px сам решает,
          сколько колонок поместится: при недостатке ширины блоки переносятся
          друг под друга, а не сжимаются до нечитаемого состояния. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 720, overflowY: "auto" }}>
          {visibleRacks.map((rack, idx) => {
            const occ = occupancyByRack[idx]?.data;
            const total = occ?.length ?? 0;
            const used = occ?.filter((c) => c.unit).length ?? 0;
            const pct = total > 0 ? Math.round((used / total) * 100) : 0;
            const rulesCount = rulesByRack[idx]?.data?.length ?? 0;
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
                <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 6 }}>
                  <Typography.Text strong>{rack.code}</Typography.Text>
                  <Tag color={rack.type === "roll" ? "blue" : "gold"}>{typeLabels[rack.type]}</Tag>
                </Space>
                <Progress
                  percent={pct}
                  size="small"
                  showInfo={false}
                  strokeColor={pct >= 90 ? "#C97A2B" : "#1D9E75"}
                  trailColor="#EDEDEC"
                />
                <Space style={{ width: "100%", justifyContent: "space-between", marginTop: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {total > 0 ? `${used} из ${total} ячеек${pct >= 90 ? " — почти полон" : ""}` : "—"}
                  </Typography.Text>
                  <Typography.Text style={{ fontSize: 11.5, fontWeight: 700, color: rulesCount > 0 ? "#146B4E" : "#B8483C" }}>
                    {rulesCount > 0 ? `${rulesCount} правил${rulesCount === 1 ? "о" : "а"}` : "нет правил"}
                  </Typography.Text>
                </Space>
              </Card>
            );
          })}
        </div>

        {selectedRack ? (
          <Card>
            <Space style={{ width: "100%", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <Typography.Title level={5} style={{ marginBottom: 2 }}>
                  Стеллаж {selectedRack.code} — {typeLabels[selectedRack.type]}, {selectedRack.shelf_count} полок
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  {warehousesQuery.data?.find((w) => w.id === selectedRack.warehouse_id)?.name ?? "—"}
                  {occupancyForSelected && ` · ${occupancyForSelected.filter((c) => c.unit).length} из ${occupancyForSelected.length} ячеек занято`}
                </Typography.Text>
              </div>
              {canManage && (
                <Button
                  size="small"
                  onClick={() => {
                    setEditingRack(selectedRack);
                    editRackForm.setFieldsValue({
                      code: selectedRack.code,
                      type: selectedRack.type,
                      shelf_count: selectedRack.shelf_count,
                      warehouse_id: selectedRack.warehouse_id,
                    });
                  }}
                >
                  Изменить параметры
                </Button>
              )}
            </Space>

            {selectedRack.type === "roll" ? (
              // Рулонный стеллаж — на полке всегда один рулон, простраственная
              // сетка тут почти ничего не говорит (только "занято/свободно").
              // Вместо тесной колонки боксов — строка на полку с содержимым
              // сразу видно, без клика по каждой ячейке; та же рамка/цвета,
              // что у штрипсовой сетки, чтобы экран не выглядел двумя разными
              // интерфейсами.
              <div style={{ background: "#fff", border: "1px solid #DEDEDA", borderRadius: 10, padding: 14, marginBottom: 8 }}>
                <RollShelfRows byShelf={byShelf} navigate={navigate} />
              </div>
            ) : (
              <div
                style={{
                  display: "inline-grid",
                  gridTemplateColumns: `56px repeat(${columns}, 44px)`,
                  gap: 6,
                  alignItems: "center",
                  background: "#fff",
                  border: "1px solid #DEDEDA",
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 8,
                }}
              >
                {byShelf.map(([shelf, cells]) => (
                  <FragmentRow key={shelf} shelf={shelf} cells={cells} columns={columns} navigate={navigate} />
                ))}
              </div>
            )}
            <Space style={{ marginBottom: 20 }} size="middle">
              <LegendSwatch color="#f0f0f0" border="#d9d9d9" label="свободно" />
              <LegendSwatch color="#e7f5ee" border="#1D9E75" label="занято" />
            </Space>

            <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 10 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Правила зонирования — какая плёнка идёт в какие полки
              </Typography.Title>
              {canManage && (
                <Button size="small" type="primary" onClick={() => setRuleModalOpen(true)}>
                  + Добавить правило
                </Button>
              )}
            </Space>
            {rulesForSelected && rulesForSelected.length > 0 ? (
              <Space direction="vertical" style={{ width: "100%" }} size={6}>
                {rulesForSelected.map((rule: MacroZoneRule) => (
                  <Card key={rule.id} size="small" style={{ background: "#fff" }}>
                    <Space style={{ width: "100%", justifyContent: "space-between" }}>
                      <span>
                        <Typography.Text strong style={{ marginRight: 10 }}>
                          Полки {rule.from_shelf}–{rule.to_shelf}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {materialName(rule.material_id)}, {colorName(rule.color_id)}, {thicknessName(rule.thickness_id)}, {manufacturerName(rule.manufacturer_id)}
                        </Typography.Text>
                      </span>
                      {canManage && (
                        <Popconfirm title="Удалить правило?" onConfirm={() => deleteRuleMutation.mutate(rule.id)}>
                          <Button size="small" danger>
                            Удалить
                          </Button>
                        </Popconfirm>
                      )}
                    </Space>
                  </Card>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                Правил нет — весь стеллаж буферная зона, автоподбор ячейки при приёмке предложит сюда любую позицию.
              </Typography.Text>
            )}
          </Card>
        ) : (
          <Card style={{ textAlign: "center", padding: "24px 8px", color: "#8A8C99" }}>Выберите стеллаж слева.</Card>
        )}
      </div>

      {rackFormModal()}

      <Modal title={`Изменить стеллаж ${editingRack?.code ?? ""}`} open={!!editingRack} onCancel={() => setEditingRack(null)} footer={null} destroyOnHidden>
        <Form form={editRackForm} layout="vertical" onFinish={(v) => editingRack && updateRackMutation.mutate({ id: editingRack.id, payload: v })}>
          <Form.Item name="code" label="Код" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="type" label="Тип" rules={[{ required: true }]}>
            <Select options={[{ value: "roll", label: "Рулонный" }, { value: "strip", label: "Штрипсовый" }]} />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Склад" rules={[{ required: true }]}>
            <Select options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={updateRackMutation.isPending}>
              Сохранить
            </Button>
            <Button onClick={() => updateRackMutation.mutate({ id: editingRack!.id, payload: { is_active: false } })}>
              В архив
            </Button>
          </Space>
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

/** Нераспределённые остатки без стеллажей — единицы физически на складе
 * (Принят/На_хранении), но без ячейки: зависли посреди приёмки, после
 * возврата (адрес всегда сбрасывается) или после резки без указанного
 * места для остатка. Без этой карточки они не видны нигде в "Стеллажах",
 * потому что не привязаны ни к одному стеллажу. */
function UnplacedUnitsCard() {
  const unplacedQuery = useQuery({ queryKey: ["units-unplaced"], queryFn: () => searchUnits({ unplaced: true }) });
  if (!unplacedQuery.data || unplacedQuery.data.length === 0) return null;

  return (
    <Card
      size="small"
      style={{ background: "#FBEAE7", borderColor: "#E3B5AC" }}
      title={`⚠️ Без места: ${unplacedQuery.data.length}`}
    >
      <Space direction="vertical" style={{ width: "100%" }} size={6}>
        {unplacedQuery.data.map((u) => (
          <UnplacedRow key={u.id} unit={u} />
        ))}
      </Space>
    </Card>
  );
}

function UnplacedRow({ unit }: { unit: MaterialUnit }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const suggestion = useQuery({
    queryKey: ["suggest-location", "unplaced", unit.id],
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku.id, width_mm: unit.width_mm, parent_id: unit.parent_id }),
  });
  const placeMutation = useMutation({
    mutationFn: (locationCode: string) => placeUnit(unit.id, locationCode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      qc.invalidateQueries({ queryKey: ["rack-occupancy"] });
      message.success(`№${unit.id} размещён`);
    },
    onError: () => message.error("Не удалось разместить"),
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "#fff",
        border: "1px solid #E3B5AC",
        borderRadius: 8,
        padding: "7px 12px",
      }}
    >
      <Space size={12}>
        <Typography.Text strong>№{unit.id}</Typography.Text>
        <Typography.Text>{skuLabel(unit.material_sku)}</Typography.Text>
        <Typography.Text type="secondary">
          {unit.width_mm}×{unit.length_m} м
        </Typography.Text>
        <Tag>{unit.status.replace(/_/g, " ")}</Tag>
      </Space>
      <Space size={8}>
        {suggestion.data ? (
          <>
            <Tag color="orange">{suggestion.data}</Tag>
            <Button size="small" type="primary" loading={placeMutation.isPending} onClick={() => placeMutation.mutate(suggestion.data!)}>
              Разместить
            </Button>
          </>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {suggestion.isLoading ? "подбираем ячейку…" : "нет подходящего правила"}
          </Typography.Text>
        )}
        <Button size="small" onClick={() => navigate("/m/unit-card", { state: { unitId: unit.id } })}>
          Вручную
        </Button>
      </Space>
    </div>
  );
}

function RollShelfRows({
  byShelf,
  navigate,
}: {
  byShelf: [number, RackOccupancyCell[]][];
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {byShelf.map(([shelf, cells]) => {
        const cellData = cells[0];
        const occupied = !!cellData?.unit;
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
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                minHeight: 32,
              }}
            >
              {occupied ? (
                <>
                  {/* min-width:0 + flex-wrap — без этого на узком экране
                      (планшет) кнопки справа не давали блоку с текстом
                      сжаться, и текст переносился по одной букве в строку. */}
                  <div style={{ minWidth: 0, flex: "1 1 240px", display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                    <Typography.Text strong>№{cellData!.unit!.id}</Typography.Text>
                    <Typography.Text>{skuLabel(cellData!.unit!.material_sku)}</Typography.Text>
                    <Typography.Text type="secondary">
                      {cellData!.unit!.width_mm}×{cellData!.unit!.length_m} м
                    </Typography.Text>
                  </div>
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Button size="small" onClick={() => navigate("/m/unit-card", { state: { unitId: cellData!.unit!.id } })}>
                      Карточка
                    </Button>
                    <Button size="small" onClick={() => navigate("/materials", { state: skuToPrefill(cellData!.unit!.material_sku) })}>
                      В остатках
                    </Button>
                  </Space>
                </>
              ) : (
                <Typography.Text type="secondary">{cellData?.location_code ?? ""} — свободно</Typography.Text>
              )}
            </div>
          </div>
        );
      })}
    </div>
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
            <Space size={4}>
              <Button size="small" onClick={() => navigate("/m/unit-card", { state: { unitId: cellData.unit!.id } })}>
                Карточка единицы
              </Button>
              <Button size="small" onClick={() => navigate("/materials", { state: skuToPrefill(cellData.unit!.material_sku) })}>
                В остатках
              </Button>
            </Space>
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

function WarehousesTab() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [form] = Form.useForm<{ name: string; address?: string }>();
  const [editForm] = Form.useForm<WarehouseUpdate>();

  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });

  const createMutation = useMutation({
    mutationFn: createWarehouse,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouses"] });
      setModalOpen(false);
      form.resetFields();
      message.success("Склад добавлен");
    },
    onError: () => message.error("Не удалось добавить — название уже занято?"),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: WarehouseUpdate }) => updateWarehouse(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouses"] });
      setEditingWarehouse(null);
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить — название уже занято?"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Склады"
        extra={
          <Button type="primary" onClick={() => setModalOpen(true)}>
            Добавить склад
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          Физическая площадка, на которой стоят стеллажи — код стеллажа остаётся уникальным во всей системе, склад
          лишь группирует стеллажи (раздел про мультисклад).
        </Typography.Paragraph>
        <ResponsiveTable<Warehouse>
          rowKey="id"
          loading={warehousesQuery.isLoading}
          dataSource={warehousesQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Адрес", dataIndex: "address", render: (v: string | null) => v ?? "—" },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активен</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, w) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingWarehouse(w);
                      editForm.setFieldsValue({ name: w.name, address: w.address ?? undefined });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => updateMutation.mutate({ id: w.id, payload: { is_active: !w.is_active } })}>
                    {w.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="Новый склад" open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={form} onFinish={(v) => createMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Адрес (опционально)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Изменить склад ${editingWarehouse?.name ?? ""}`}
        open={!!editingWarehouse}
        onCancel={() => setEditingWarehouse(null)}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) => editingWarehouse && updateMutation.mutate({ id: editingWarehouse.id, payload: v })}
        >
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="address" label="Адрес">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={updateMutation.isPending}>
            Сохранить
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
          { key: "racks", label: "Стеллажи и ячейки", children: <RacksConsole /> },
          ...(canManage ? [{ key: "warehouses", label: "Склады", children: <WarehousesTab /> }] : []),
        ]}
      />
    </Card>
  );
}
