import { useEffect, useMemo, useState } from "react";
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
  Alert,
  message,
} from "antd";
import { DownOutlined, SearchOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  searchUnits,
  receiveAndAutoPlace,
  placeUnit,
  printLabel,
  writeOffUnit,
  deleteUnit,
  skuLabel,
  type MaterialUnit,
  type SearchParams,
  type UnitStatusValue,
} from "../../api/units";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import { getStockSummary, type StockSummaryLine } from "../../api/reports";
import { listAbcClasses, recomputeAbc } from "../../api/abc";
import { createMaterialSku, type MaterialSkuCreate } from "../../api/dictionaries";
import { listRacks, suggestLocation } from "../../api/storage";
import { listAreas } from "../../api/areas";
import DictAutoComplete from "../../components/DictAutoComplete";
import { useAuth } from "../../auth/AuthContext";
import { exportToCsv } from "../../utils/csv";

const statusOptions: { value: UnitStatusValue; label: string }[] = [
  { value: "Принят", label: "Принят" },
  { value: "На_хранении", label: "На хранении" },
  { value: "Выдан_участку", label: "Выдан участку" },
  { value: "Списан", label: "Списан" },
];

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

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

export default function MaterialsExplorer() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const canManageAbc = !!user?.is_superuser || !!user?.permissions.includes("calc_settings.manage");
  const canWriteOff = !!user?.is_superuser || !!user?.permissions.includes("units.writeoff");
  const canPlace = !!user?.is_superuser || !!user?.permissions.includes("units.place");
  const isUchastka = !!user?.roles.some((r) => r.code === "nachalnik_uchastka");

  const [viewMode, setViewMode] = useState<"positions" | "units">(isUchastka ? "units" : "positions");
  const [donorOnly, setDonorOnly] = useState(false);
  const [filters, setFilters] = useState<SearchParams>(
    isUchastka ? { status: "Выдан_участку", area: user?.area ?? undefined } : {},
  );
  const [globalQuery, setGlobalQuery] = useState("");

  // Запрос из глобального поиска в шапке (9.7 раздел бэклога доработок) —
  // AppLayout передаёт текст через location.state, а не query-параметр,
  // чтобы не плодить читаемый в адресной строке дубль состояния фильтров.
  // Реагируем на сам объект state (не только на маунт), иначе повторный
  // поиск из шапки, когда "Остатки" уже открыты, не долетал бы.
  useEffect(() => {
    const stateQuery = (location.state as { globalQuery?: string } | null)?.globalQuery;
    if (stateQuery) setGlobalQuery(stateQuery);
  }, [location.state]);

  const [selectedUnitIds, setSelectedUnitIds] = useState<number[]>([]);
  const [createPositionOpen, setCreatePositionOpen] = useState(false);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [createdUnits, setCreatedUnits] = useState<MaterialUnit[]>([]);
  const [positionForm] = Form.useForm<MaterialSkuCreate>();
  const [unitForm] = Form.useForm<UnitLineValues>();
  const [writeOffForm] = Form.useForm<{ reason: string; note?: string }>();
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons"], queryFn: listWriteOffReasons });

  const positionsQuery = useQuery({ queryKey: ["materials-explorer", "positions"], queryFn: getStockSummary, enabled: viewMode === "positions" });
  const unitsQuery = useQuery({
    queryKey: ["materials-explorer", "units", filters],
    queryFn: () => searchUnits(filters),
    enabled: viewMode === "units",
  });
  const classesQuery = useQuery({ queryKey: ["abc-classes", "all"], queryFn: () => listAbcClasses() });
  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: () => listRacks() });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  // Кросс-ссылка "На стеллаже" (раздел про организацию меню — Остатки и
  // Стеллажи не мержим, но связываем переходом) — код стеллажа не хранится
  // на единице отдельно, только адрес ячейки целиком ("Р-1-01"), поэтому
  // ищем стеллаж, чей код — самый длинный совпадающий префикс адреса.
  const rackForLocation = (locationCode: string | null) => {
    if (!locationCode || !racksQuery.data) return null;
    const matches = racksQuery.data.filter((r) => locationCode.startsWith(r.code + "-"));
    if (matches.length === 0) return null;
    return matches.reduce((longest, r) => (r.code.length > longest.code.length ? r : longest));
  };

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

  // Пакетные операции (раздел про ускорение работы) — списание нескольких
  // единиц за один заход вместо карточки на каждую. Backend-эндпоинт под
  // это заводить не стали — цикл по уже существующему одиночному
  // writeOffUnit, тот же клиентский паттерн, что уже в receiveAndAutoPlace.
  const bulkWriteOffMutation = useMutation({
    mutationFn: async (values: { reason: string; note?: string }) => {
      for (const id of selectedUnitIds) await writeOffUnit(id, values.reason, values.note);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      message.success(`Списано единиц: ${selectedUnitIds.length}`);
      setSelectedUnitIds([]);
      setWriteOffOpen(false);
      writeOffForm.resetFields();
    },
    onError: () => message.error("Не удалось списать часть единиц — проверьте статусы"),
  });

  const deleteUnitMutation = useMutation({
    mutationFn: (id: number) => deleteUnit(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Единица удалена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить — возможно, от неё отрезан остаток")),
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
            <DictAutoComplete kind="materials" placeholder="Материал" value={filters.material} onChange={(v) => setFilter("material", v || undefined)} allowCreate={false} />
            <DictAutoComplete kind="colors" placeholder="Цвет" value={filters.color} onChange={(v) => setFilter("color", v || undefined)} allowCreate={false} />
            <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={filters.thickness} onChange={(v) => setFilter("thickness", v ?? undefined)} />
            {viewMode === "units" && (
              <>
                <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={filters.manufacturer} onChange={(v) => setFilter("manufacturer", v || undefined)} allowCreate={false} />
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
        <Card
          extra={
            <Button
              onClick={() =>
                exportToCsv(
                  "ostatki-po-pozitsiyam.csv",
                  filteredPositions,
                  [
                    { key: "material", header: "Материал" },
                    { key: "color", header: "Цвет" },
                    { key: "thickness", header: "Толщина, мм" },
                    { key: "total_area_m2", header: "Остаток, м²" },
                    { key: "unit_count", header: "Единиц" },
                  ],
                )
              }
            >
              Экспорт в Excel
            </Button>
          }
        >
          <Table<StockSummaryLine>
            rowKey={(r) => `${r.material}-${r.color}-${r.thickness}`}
            loading={positionsQuery.isLoading}
            dataSource={filteredPositions}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
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
        <Card
          extra={
            <Button
              onClick={() =>
                exportToCsv(
                  "ostatki-po-edinitsam.csv",
                  displayedUnits.map((u) => ({
                    id: u.id,
                    material: skuLabel(u.material_sku),
                    width_mm: u.width_mm,
                    length_m: u.length_m,
                    status: u.status.replace(/_/g, " "),
                    location: u.location_code ?? (u.area ? areaLabel(u.area) : "") ?? "",
                  })),
                  [
                    { key: "id", header: "ID" },
                    { key: "material", header: "Материал" },
                    { key: "width_mm", header: "Ширина, мм" },
                    { key: "length_m", header: "Длина, м" },
                    { key: "status", header: "Статус" },
                    { key: "location", header: "Адрес/участок" },
                  ],
                )
              }
            >
              Экспорт в Excel
            </Button>
          }
        >
          {canWriteOff && selectedUnitIds.length > 0 && (
            <Space style={{ marginBottom: 12 }}>
              <Typography.Text>Выбрано: {selectedUnitIds.length}</Typography.Text>
              <Button danger onClick={() => setWriteOffOpen(true)}>
                Списать выбранные ({selectedUnitIds.length})
              </Button>
            </Space>
          )}
          <Table<MaterialUnit>
            rowKey="id"
            loading={unitsQuery.isLoading}
            dataSource={displayedUnits}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
            rowSelection={
              canWriteOff
                ? { selectedRowKeys: selectedUnitIds, onChange: (keys) => setSelectedUnitIds(keys as number[]) }
                : undefined
            }
            onRow={(u) => ({
              onClick: (e) => {
                if ((e.target as HTMLElement).closest(".ant-checkbox-wrapper")) return;
                navigate("/m/unit-card", { state: { unitId: u.id } });
              },
            })}
            columns={[
              { title: "ID", dataIndex: "id", sorter: (a, b) => a.id - b.id },
              { title: "Материал", render: (_, u) => skuLabel(u.material_sku) },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м`, sorter: (a, b) => a.width_mm - b.width_mm },
              { title: "Статус", render: (_, u) => u.status.replace(/_/g, " ") },
              {
                title: "Адрес/участок",
                render: (_, u) => {
                  const rack = rackForLocation(u.location_code);
                  const placeable = canPlace && !u.location_code && (u.status === "Принят" || u.status === "На_хранении");
                  return (
                    <Space size={6}>
                      <span>{u.location_code ?? (u.area ? areaLabel(u.area) : null) ?? "—"}</span>
                      {rack && (
                        <a
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("/storage", { state: { rackId: rack.id } });
                          }}
                        >
                          на стеллаже →
                        </a>
                      )}
                      {placeable && <SuggestPlaceButton unit={u} />}
                    </Space>
                  );
                },
              },
              {
                title: "",
                render: (_, u) =>
                  canWriteOff && (
                    <Button
                      size="small"
                      danger
                      loading={deleteUnitMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteUnitMutation.mutate(u.id);
                      }}
                    >
                      {user?.is_superuser ? "Удалить" : "Запросить удаление"}
                    </Button>
                  ),
              },
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

      <Modal
        title={`Списать выбранные (${selectedUnitIds.length})`}
        open={writeOffOpen}
        onCancel={() => setWriteOffOpen(false)}
        onOk={() => writeOffForm.submit()}
        okButtonProps={{ danger: true, loading: bulkWriteOffMutation.isPending }}
        okText="Списать"
        destroyOnHidden
      >
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Отменить нельзя — используйте для повреждённых/испорченных партий. Причина и заметка применятся ко всем выбранным единицам."
        />
        <Form form={writeOffForm} layout="vertical" onFinish={(v) => bulkWriteOffMutation.mutate(v)}>
          <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
            <Select
              loading={writeOffReasonsQuery.isLoading}
              options={(writeOffReasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))}
              placeholder="Выберите причину"
            />
          </Form.Item>
          <Form.Item name="note" label="Заметка (опционально)">
            <Input.TextArea rows={2} placeholder="Детали для претензии поставщику" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** Раздел про кнопку "подставить место" — единицы без адреса (зависли
 * после возврата/резки/приёмки без места) уже видны в общем списке
 * "Остатки", но раньше место можно было назначить только через отдельный
 * "Без места" на "Стеллажах" или карточку единицы. Тот же автоподбор по
 * правилам зонирования (suggestLocation), что и там, прямо в строке
 * таблицы. */
function SuggestPlaceButton({ unit }: { unit: MaterialUnit }) {
  const qc = useQueryClient();
  const suggestion = useQuery({
    queryKey: ["suggest-location", "materials-explorer", unit.id],
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku.id, width_mm: unit.width_mm, parent_id: unit.parent_id }),
  });
  const placeMutation = useMutation({
    mutationFn: (locationCode: string) => placeUnit(unit.id, locationCode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials-explorer", "units"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      message.success(`№${unit.id} размещён`);
    },
    onError: () => message.error("Не удалось разместить"),
  });

  if (!suggestion.data) return null;
  return (
    <Button
      size="small"
      type="link"
      style={{ padding: 0 }}
      loading={placeMutation.isPending}
      onClick={(e) => {
        e.stopPropagation();
        placeMutation.mutate(suggestion.data!);
      }}
    >
      Подставить {suggestion.data}
    </Button>
  );
}
