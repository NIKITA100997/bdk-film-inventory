import { useMemo, useState } from "react";
import {
  Card,
  Radio,
  Switch,
  Button,
  Space,
  Select,
  InputNumber,
  Input,
  Table,
  Typography,
  Dropdown,
  Modal,
  Form,
  List,
  message,
} from "antd";
import { DownOutlined, SearchOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  searchUnits,
  receiveAndAutoPlace,
  printLabel,
  skuLabel,
  type MaterialUnit,
  type SearchParams,
  type UnitStatusValue,
} from "../../api/units";
import { getStockSummary, type StockSummaryLine } from "../../api/reports";
import { listAbcClasses, recomputeAbc } from "../../api/abc";
import { createMaterialSku, type MaterialSkuCreate } from "../../api/dictionaries";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";

const statusOptions: { value: UnitStatusValue; label: string }[] = [
  { value: "Принят", label: "Принят" },
  { value: "На_хранении", label: "На хранении" },
  { value: "Выдан_участку", label: "Выдан участку" },
  { value: "Списан", label: "Списан" },
];

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};
const areaOptions = Object.entries(areaLabels).map(([value, label]) => ({ value, label }));

type UnitLineValues = {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  upd_number?: string;
  pallet_number?: string;
};

export default function MaterialsExplorer() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canManageAbc = user?.role === "logist" || user?.role === "admin";
  const isUchastka = user?.role === "nachalnik_uchastka";

  const [viewMode, setViewMode] = useState<"positions" | "units">(isUchastka ? "units" : "positions");
  const [donorOnly, setDonorOnly] = useState(false);
  const [filters, setFilters] = useState<SearchParams>(
    isUchastka ? { status: "Выдан_участку", area: user?.area ?? undefined } : {},
  );
  const [globalQuery, setGlobalQuery] = useState("");
  const [createPositionOpen, setCreatePositionOpen] = useState(false);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [createdUnits, setCreatedUnits] = useState<MaterialUnit[]>([]);
  const [positionForm] = Form.useForm<MaterialSkuCreate>();
  const [unitForm] = Form.useForm<UnitLineValues>();

  const positionsQuery = useQuery({ queryKey: ["materials-explorer", "positions"], queryFn: getStockSummary, enabled: viewMode === "positions" });
  const unitsQuery = useQuery({
    queryKey: ["materials-explorer", "units", filters],
    queryFn: () => searchUnits(filters),
    enabled: viewMode === "units",
  });
  const classesQuery = useQuery({ queryKey: ["abc-classes", "all"], queryFn: () => listAbcClasses() });

  const recomputeMutation = useMutation({
    mutationFn: () => recomputeAbc(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["abc-classes"] });
      message.success(`Пересчитано позиций: ${r.updated} (период ${r.period_days} дн.)`);
    },
    onError: () => message.error("Не удалось пересчитать"),
  });

  const createPositionMutation = useMutation({
    mutationFn: (v: MaterialSkuCreate) => createMaterialSku(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      setCreatePositionOpen(false);
      positionForm.resetFields();
      message.success("Позиция создана");
    },
    onError: () => message.error("Не удалось создать — такая позиция уже есть?"),
  });

  const createUnitMutation = useMutation({
    mutationFn: (v: UnitLineValues) =>
      receiveAndAutoPlace({
        ...v,
        upd_number: v.upd_number?.trim() || "Без документа",
        pallet_number: v.pallet_number?.trim() || "-",
        quantity: 1,
      }),
    onSuccess: (units) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      setCreatedUnits(units);
      unitForm.resetFields();
      message.success(`Единица №${units[0].id} зарегистрирована`);
    },
    onError: () => message.error("Не удалось зарегистрировать единицу"),
  });

  const classCKeys = useMemo(() => {
    const set = new Set<string>();
    for (const c of classesQuery.data ?? []) {
      if (c.width_class === "C") set.add(`${c.material}|${c.color}|${c.thickness}|${c.width_mm}`);
    }
    return set;
  }, [classesQuery.data]);

  const lastRecomputed = useMemo(() => {
    const dates = (classesQuery.data ?? []).map((c) => c.computed_at);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [classesQuery.data]);

  const setFilter = <K extends keyof SearchParams>(key: K, value: SearchParams[K] | undefined) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const trimmedQuery = globalQuery.trim();
  const isNumericQuery = /^\d+$/.test(trimmedQuery);
  const textQuery = !isNumericQuery ? trimmedQuery.toLowerCase() : "";

  const runGlobalSearch = () => {
    if (isNumericQuery) navigate("/m/unit-card", { state: { unitId: Number(trimmedQuery) } });
  };

  const filteredPositions = (positionsQuery.data ?? []).filter((p) => {
    if (filters.material && p.material !== filters.material) return false;
    if (filters.color && p.color !== filters.color) return false;
    if (filters.thickness !== undefined && p.thickness !== filters.thickness) return false;
    if (textQuery && !`${p.material} ${p.color}`.toLowerCase().includes(textQuery)) return false;
    return true;
  });

  const displayedUnits = (unitsQuery.data ?? []).filter((u) => {
    if (donorOnly) {
      const key = `${u.material_sku.material.name}|${u.material_sku.color.name}|${u.material_sku.thickness.value_mm}|${u.width_mm}`;
      if (!(u.status === "На_хранении" && classCKeys.has(key))) return false;
    }
    if (textQuery) {
      const label = `${u.material_sku.material.name} ${u.material_sku.color.name}`.toLowerCase();
      if (!label.includes(textQuery)) return false;
    }
    return true;
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Материалы"
        extra={
          <Dropdown
            menu={{
              items: [
                { key: "position", label: "Материал — позиция без рулона" },
                { key: "unit", label: "Единица плёнки — один рулон вне сессии" },
              ],
              onClick: ({ key }) => (key === "position" ? setCreatePositionOpen(true) : setCreateUnitOpen(true)),
            }}
          >
            <Button type="primary">
              + Новое <DownOutlined />
            </Button>
          </Dropdown>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Input
            size="large"
            prefix={<SearchOutlined />}
            placeholder="Введите ID единицы (переход в карточку) или название материала…"
            value={globalQuery}
            onChange={(e) => setGlobalQuery(e.target.value)}
            onPressEnter={runGlobalSearch}
          />

          <Space wrap>
            <Radio.Group value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
              <Radio.Button value="positions">По позициям материала</Radio.Button>
              <Radio.Button value="units">По физическим единицам</Radio.Button>
            </Radio.Group>
            {canManageAbc && (
              <Button onClick={() => recomputeMutation.mutate()} loading={recomputeMutation.isPending}>
                Пересчитать ABC
              </Button>
            )}
            {lastRecomputed && (
              <Typography.Text type="secondary">
                Классы пересчитаны: {new Date(lastRecomputed).toLocaleString("ru-RU")}
              </Typography.Text>
            )}
          </Space>

          <Space wrap>
            <DictAutoComplete kind="materials" placeholder="Материал" value={filters.material} onChange={(v) => setFilter("material", v || undefined)} />
            <DictAutoComplete kind="colors" placeholder="Цвет" value={filters.color} onChange={(v) => setFilter("color", v || undefined)} />
            <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={filters.thickness} onChange={(v) => setFilter("thickness", v ?? undefined)} />
            {viewMode === "units" && (
              <>
                <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={filters.manufacturer} onChange={(v) => setFilter("manufacturer", v || undefined)} />
                <InputNumber placeholder="Ширина, мм" min={1} value={filters.width_mm} onChange={(v) => setFilter("width_mm", v ?? undefined)} />
                <InputNumber placeholder="Мин. длина, м" min={0} step={0.1} value={filters.min_length_m} onChange={(v) => setFilter("min_length_m", v ?? undefined)} />
                <Select placeholder="Статус" allowClear style={{ width: 160 }} options={statusOptions} value={filters.status} onChange={(v) => setFilter("status", v)} />
                <Select placeholder="Участок" allowClear style={{ width: 180 }} options={areaOptions} value={filters.area} onChange={(v) => setFilter("area", v)} />
                <Space size={4}>
                  <Switch checked={donorOnly} onChange={setDonorOnly} />
                  <Typography.Text>класс C, есть донор-кандидат</Typography.Text>
                </Space>
              </>
            )}
          </Space>
        </Space>
      </Card>

      {viewMode === "positions" ? (
        <Card>
          <Table<StockSummaryLine>
            rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
            loading={positionsQuery.isLoading}
            dataSource={filteredPositions}
            pagination={{ pageSize: 20 }}
            onRow={(r) => ({
              onClick: () =>
                navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } }),
            })}
            columns={[
              { title: "Материал", render: (_, r) => `${r.material}, ${r.color}, ${r.thickness} мм`, sorter: (a, b) => a.material.localeCompare(b.material) },
              { title: "Остаток, м²", dataIndex: "total_area_m2", sorter: (a, b) => a.total_area_m2 - b.total_area_m2 },
              { title: "Единиц", dataIndex: "unit_count", sorter: (a, b) => a.unit_count - b.unit_count },
            ]}
          />
        </Card>
      ) : (
        <Card>
          <Table<MaterialUnit>
            rowKey="id"
            loading={unitsQuery.isLoading}
            dataSource={displayedUnits}
            pagination={{ pageSize: 20 }}
            onRow={(u) => ({ onClick: () => navigate("/m/unit-card", { state: { unitId: u.id } }) })}
            columns={[
              { title: "ID", dataIndex: "id", sorter: (a, b) => a.id - b.id },
              { title: "Материал", render: (_, u) => skuLabel(u.material_sku) },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м`, sorter: (a, b) => a.width_mm - b.width_mm },
              { title: "Статус", render: (_, u) => u.status.replace(/_/g, " ") },
              { title: "Адрес/участок", render: (_, u) => u.location_code ?? (u.area ? areaLabels[u.area] : null) ?? "—" },
            ]}
          />
        </Card>
      )}

      <Modal title="Новая позиция материала" open={createPositionOpen} onCancel={() => setCreatePositionOpen(false)} footer={null} destroyOnHidden>
        <Typography.Paragraph type="secondary">Без физического рулона — например, под будущую поставку.</Typography.Paragraph>
        <Form form={positionForm} layout="vertical" onFinish={(v) => createPositionMutation.mutate(v)}>
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
            <DictAutoComplete kind="manufacturers" />
          </Form.Item>
          <Form.Item name="supplier_code" label="Код у поставщика (опционально)">
            <Input />
          </Form.Item>
          <Form.Item name="native_width_mm" label="Родная ширина рулона, мм (опционально)">
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createPositionMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title="Единица плёнки вне сессии приёмки"
        open={createUnitOpen}
        onCancel={() => {
          setCreateUnitOpen(false);
          setCreatedUnits([]);
        }}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Один физический рулон/штрипс без открытия сессии приёмки (2.3) — например, единичное поступление без
          полноценной партии. УПД/паллета необязательны.
        </Typography.Paragraph>
        <Form form={unitForm} layout="vertical" onFinish={(v) => createUnitMutation.mutate(v)}>
          <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
            <DictAutoComplete kind="materials" />
          </Form.Item>
          <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
            <DictAutoComplete kind="colors" />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
            <DictAutoComplete kind="manufacturers" />
          </Form.Item>
          <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
            <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="upd_number" label="Номер УПД (необязательно)">
            <Input placeholder="Без документа" />
          </Form.Item>
          <Form.Item name="pallet_number" label="Номер паллеты (необязательно)">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createUnitMutation.isPending}>
            Зарегистрировать
          </Button>
        </Form>

        {createdUnits.length > 0 && (
          <List
            style={{ marginTop: 16 }}
            size="small"
            bordered
            dataSource={createdUnits}
            renderItem={(u) => (
              <List.Item actions={[<Button key="print" size="small" onClick={() => printLabel(u.id)}>Печать бирки</Button>]}>
                № {u.id} — {u.width_mm}×{u.length_m}, {u.location_code ?? "без места"}
              </List.Item>
            )}
          />
        )}
      </Modal>
    </Space>
  );
}
