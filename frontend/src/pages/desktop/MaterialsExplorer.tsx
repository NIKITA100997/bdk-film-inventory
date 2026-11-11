import { useEffect, useMemo, useState } from "react";
import ShortageTags from "../../components/ShortageTags";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Dropdown,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { DownOutlined, SearchOutlined, FileExcelOutlined, ShoppingCartOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  searchUnits,
  bulkEditUnits,
  UNIT_SEARCH_LIMIT,
  receiveAndAutoPlace,
  placeUnit,
  printLabel,
  printLabelsBatch,
  writeOffUnit,
  deleteUnit,
  getUnit,
  cutUnit,
  skuLabel,
  rub,
  type MaterialUnit,
  type SearchParams,
  type UnitStatusValue,
} from "../../api/units";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import { getStockSummary, getRollsVsStrips, type StockSummaryLine, type RollsVsStripsLine } from "../../api/reports";
import { getRollWidths, getStockOverview, type RollWidths, type StockOverviewLine } from "../../api/purchasing";
import FilmCartDrawer from "../../components/FilmCartDrawer";
import { filmCart, filmKey, useFilmCart } from "../../utils/filmCart";
import { normsLabel } from "../../utils/normatives";
import { listAbcClasses, recomputeAbc } from "../../api/abc";
import { createMaterialSku, type MaterialSkuCreate } from "../../api/dictionaries";
import { listRacks, suggestLocation } from "../../api/storage";
import { listAreas } from "../../api/areas";
import DictAutoComplete from "../../components/DictAutoComplete";
import ExistingSkuPicker from "../../components/ExistingSkuPicker";
import OccurredAtField from "../../components/OccurredAtField";
import ResponsiveTable from "../../components/ResponsiveTable";
import LotActions from "../../components/lotOps/LotActions";
import { lotFromUnit } from "../../components/lotOps/lotOps";
import { useAuth } from "../../auth/AuthContext";
import { exportToExcel } from "../../utils/excel";
import { UnitBulkEditModal, UnitEditModal } from "./UnitEditModals";
import UnitBulkActionModal, { type BulkAction } from "./UnitBulkActions";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { useWarehouseFilter } from "../../hooks/useWarehouseFilter";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDateTime } from "../../utils/dates";
import { rollNo } from "../../utils/lotNo";
import { hasPerm } from "../../auth/permissions";

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
  manufacturer?: string;
  width_mm: number;
  length_m: number;
  quantity?: number;
  marked_illiquid?: boolean;
  upd_number?: string;
  pallet_number?: string;
  is_strip?: boolean;
  occurred_at?: Dayjs | null;
};

interface GroupedStockLine {
  key: string;
  material: string;
  color: string;
  thickness?: number;
  isParent: boolean;
  isChild?: boolean;
  thicknesses: number[];
  total_area_m2: number;
  unit_count: number;
  value_rub?: number | null;
  unpriced_area_m2?: number;
  illiquid_area_m2?: number;
  roll_count: number;
  roll_length_m: number;
  strip_count: number;
  strip_length_m: number;
  reserved_area_m2?: number;
  panel_demand_m2?: number;
  open_requested_area_m2?: number;
  min_stock_m2?: number | null;
  min_batch_m2?: number | null;
  batch_multiple_m2?: number | null;
  to_order_m2?: number;
  shortage_m2?: number;
  shortage_tasks_m2?: number;
  shortage_min_m2?: number;
  usual_supplier?: string | null;
  days_of_stock_remaining?: number | null;
  reorder_suggested?: boolean;
  children?: GroupedStockLine[];
}

/** mode — режим задаёт экран «Остатки» своими вкладками (тогда свой
 * переключатель не показывается); без него — как раньше, сам по себе. */
export default function MaterialsExplorer({ mode }: { mode?: "positions" | "units" } = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const canManageAbc = hasPerm(user, "calc_settings.manage");
  const canWriteOff = hasPerm(user, "units.writeoff");
  const canCut = hasPerm(user, "units.cut");
  const canPlace = hasPerm(user, "units.place");
  const canEditSku = hasPerm(user, "materials.manage");
  const canCorrect = hasPerm(user, "units.correct");
  const canSeePrice = !!user?.is_superuser || ["prices.view", "prices.manage"].some((c) => user?.permissions.includes(c));
  // Правка единицы и массовые действия — у кого есть право хоть на одно из них.
  const canEditUnit = canEditSku || canCorrect || canPlace;
  const canIssue = hasPerm(user, "units.issue");
  const canReturn = hasPerm(user, "units.return");
  const canTransfer = hasPerm(user, "warehouse_transfers.manage");
  // Раздел про аудит прав — "+ Новое" показывалось всем на этой намеренно
  // открытой всем странице (/stock), хотя оба пункта — мутирующие действия
  // с реальной проверкой на бэкенде (dictionaries.py:378, units.py:116).
  const canReceive = hasPerm(user, "units.receive");
  const canCreatePosition = canReceive || canEditSku;
  // Раздел про объединение "Остатков" с "Остатками и резервом" снабженца
  // (раньше отдельная вкладка на "Закупках", дублировавшая эту же таблицу
  // без фильтров) — резерв/заявки/дозаказ подмешиваются сюда только тем,
  // у кого есть право видеть эти данные, чтобы не звать привилегированный
  // эндпоинт от лица кладовщика без этого права (получил бы 403).
  const canViewPurchasing = hasPerm(user, "purchasing.manage");
  // Корзина заказа плёнки (22.10): метры → корзина → заявка закупщику
  const canOrderFilm = hasPerm(user, "purchasing.request", "purchasing.manage");
  const [cartOpen, setCartOpen] = useState(false);
  const cart = useFilmCart();
  const rollWidthsQuery = useQuery({ queryKey: ["roll-widths"], queryFn: getRollWidths, enabled: canOrderFilm, staleTime: 600_000 });
  const widthsByFilm = useMemo(() => {
    const map = new Map<string, RollWidths>();
    for (const w of rollWidthsQuery.data ?? []) map.set(filmKey(w), w);
    return map;
  }, [rollWidthsQuery.data]);
  const isUchastka = !!user?.roles.some((r) => r.code === "nachalnik_uchastka");

  const [ownViewMode, setViewMode] = useState<"positions" | "units">(isUchastka ? "units" : "positions");
  const viewMode = mode ?? ownViewMode;
  const [donorOnly, setDonorOnly] = useState(false);
  // отбор позиций по числу рулонов на складе (22.10): «не больше N» / «есть рулоны»; null — все
  const [rollsFilter, setRollsFilter] = useState<string | null>(null);
  // Отбор по виду единицы в «По физическим единицам»: рулон / штрипс.
  const [unitKind, setUnitKind] = useState<"all" | "roll" | "strip">("all");
  // неликвид (23.10): все / только / без
  const [illiquidFilter, setIlliquidFilter] = useState<"all" | "only" | "none">("all");
  const canMarkIlliquid = hasPerm(user, "units.correct", "materials.manage");
  // Раздел про архивные позиции в "Остатках" — без группировки по
  // производителю остаток архивной позиции молча подмешивался в сумму
  // активной с тем же материалом/цветом/толщиной; по умолчанию скрыт, тот
  // же переключатель, что уже есть на "Карточке материала".
  const [showArchived, setShowArchived] = useState(false);
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

  // Раздел про объединение с "Остатками и резервом" — переход с вкладки
  // "Поставщики" ("Остатки по его плёнкам →") раньше переключал локальную
  // вкладку на "Закупках", теперь ведёт сюда с этим же фильтром.
  const [supplierFilter, setSupplierFilter] = useState<string | null>(null);
  useEffect(() => {
    const stateSupplier = (location.state as { usualSupplierFilter?: string } | null)?.usualSupplierFilter;
    if (stateSupplier) setSupplierFilter(stateSupplier);
  }, [location.state]);

  const [selectedUnitIds, setSelectedUnitIds] = useState<number[]>([]);
  const [createPositionOpen, setCreatePositionOpen] = useState(false);
  const [createUnitOpen, setCreateUnitOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [bulkCutOpen, setBulkCutOpen] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<MaterialUnit | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [createdUnits, setCreatedUnits] = useState<MaterialUnit[]>([]);
  const [positionForm] = Form.useForm<MaterialSkuCreate>();
  const [unitForm] = Form.useForm<UnitLineValues>();
  const manualQty = Form.useWatch("quantity", unitForm);
  const manualIlliquid = Form.useWatch("marked_illiquid", unitForm);
  const [writeOffForm] = Form.useForm<{ reason: string; note?: string; occurred_at?: Dayjs | null }>();
  const writeOffReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "warehouse"],
    queryFn: () => listWriteOffReasons("warehouse"),
  });

  // Раздел про остатки по конкретному складу — отдельное состояние от
  // остальных фильтров (тот же хук, что уже даёт "Отчёты"), сливается с
  // filters только в момент запроса. Один и тот же выбор склада работает
  // в обоих режимах ("по позициям" и "по единицам") — раньше warehouseId
  // передавался только в поиск по единицам, "по позициям" всегда получал
  // undefined и показывал остаток по всем складам сразу.
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  // Раздел про производителя внутри карточки материала (не отдельным
  // измерением в остатках) — группировка без производителя, тот же
  // источник, что у "Остатков по материалу" (Reports.tsx). Фильтр
  // "Производитель" теперь просто сужает исходные единицы на бэкенде.
  const positionsQuery = useQuery({
    queryKey: ["materials-explorer", "positions", showArchived, warehouseId, filters.manufacturer],
    queryFn: () => getStockSummary(warehouseId, filters.manufacturer, showArchived),
    enabled: viewMode === "positions",
  });
  // Раздел про объединение с "Остатками и резервом" — тот же эндпоинт,
  // что раньше отдельной вкладкой на "Закупках", теперь подмешивается сюда
  // по ключу материал+цвет+толщина; запрашивается только если это право
  // вообще есть, иначе кладовщик получил бы 403 от чужого эндпоинта.
  const stockOverviewQuery = useQuery({
    queryKey: ["purchasing-stock-overview"],
    queryFn: getStockOverview,
    enabled: viewMode === "positions" && canViewPurchasing,
  });
  const overviewByGroup = useMemo(() => {
    const map = new Map<string, StockOverviewLine>();
    for (const o of stockOverviewQuery.data ?? []) map.set(`${o.material}|${o.color}|${o.thickness}`, o);
    return map;
  }, [stockOverviewQuery.data]);
  // Раздел про недостающий столбец рулоны/штрипсы в "Остатках" — раньше
  // разбивку рулон/штрипс по позиции можно было увидеть только в отчёте
  // "Рулоны и штрипсы" или карточке материала, здесь (там, где обычно и
  // смотрят остаток) её не было вовсе.
  const rollsVsStripsQuery = useQuery({
    queryKey: ["materials-explorer", "rolls-vs-strips", warehouseId, filters.manufacturer],
    queryFn: () => getRollsVsStrips(warehouseId, filters.manufacturer),
    enabled: viewMode === "positions",
  });
  const rollsVsStripsByGroup = useMemo(() => {
    const map = new Map<string, RollsVsStripsLine>();
    for (const r of rollsVsStripsQuery.data ?? []) map.set(`${r.material}|${r.color}|${r.thickness}`, r);
    return map;
  }, [rollsVsStripsQuery.data]);
  const unitsQuery = useQuery({
    queryKey: ["materials-explorer", "units", filters, warehouseId, unitKind, illiquidFilter],
    // Рулон/штрипс — отбор на сервере: иначе он работал бы только по
    // пришедшей части списка.
    queryFn: () =>
      searchUnits({
        ...filters,
        warehouse_id: warehouseId,
        is_strip: unitKind === "all" ? undefined : unitKind === "strip",
        illiquid: illiquidFilter === "all" ? undefined : illiquidFilter === "only",
      }),
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
        manufacturer: v.manufacturer?.trim() || "Не указан",
        upd_number: v.upd_number?.trim() || "Без документа",
        pallet_number: v.pallet_number?.trim() || "-",
        quantity: Math.max(1, Math.min(200, Number(v.quantity) || 1)),
        marked_illiquid: !!v.marked_illiquid,
        occurred_at: toOccurredAtIso(v.occurred_at),
      }),
    onSuccess: (units) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      setCreatedUnits(units);
      unitForm.resetFields();
      if (units.length === 1) {
        message.success(`Единица ${rollNo(units[0].id)} зарегистрирована`);
      } else {
        message.success(`Зарегистрировано единиц: ${units.length} (№ ${rollNo(units[0].id)} .. ${rollNo(units[units.length - 1].id)})`);
      }
    },
    onError: () => message.error("Не удалось зарегистрировать единицу"),
  });

  // Пакетные операции (раздел про ускорение работы) — списание нескольких
  // единиц за один заход вместо карточки на каждую. Backend-эндпоинт под
  // это заводить не стали — цикл по уже существующему одиночному
  // writeOffUnit, тот же клиентский паттерн, что уже в receiveAndAutoPlace.
  const bulkWriteOffMutation = useMutation({
    mutationFn: async (values: { reason: string; note?: string; occurred_at?: Dayjs | null }) => {
      const occurredAt = toOccurredAtIso(values.occurred_at);
      for (const id of selectedUnitIds) await writeOffUnit(id, values.reason, values.note, occurredAt);
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

  // неликвид (23.10): пометить / снять у выбранных — с причиной в историю рулона
  const markIlliquid = (on: boolean) => {
    let reason = "";
    Modal.confirm({
      title: on ? `Пометить неликвидом: ${selectedUnitIds.length} шт.` : `Снять пометку неликвид: ${selectedUnitIds.length} шт.`,
      content: (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {on
              ? "Обычные задания эти рулоны брать не будут — только строки «из неликвида». В «доступно» и «заказать» они не считаются."
              : "Рулоны снова пойдут под обычные задания."}
          </Typography.Text>
          <Input placeholder="Причина (необязательно)" maxLength={200} onChange={(e) => (reason = e.target.value)} />
        </Space>
      ),
      okText: on ? "Пометить" : "Снять",
      onOk: async () => {
        try {
          const r = await bulkEditUnits({ unit_ids: selectedUnitIds, illiquid: on, reason: reason.trim() || undefined });
          message.success(`Изменено: ${r.updated}`);
          qc.invalidateQueries({ queryKey: ["materials-explorer"] });
          setSelectedUnitIds([]);
        } catch (e) {
          message.error(apiErrorMessage(e, "Не удалось изменить"));
          throw e;
        }
      },
    });
  };

  const exportSelected = () => {
                  const chosen = new Set(selectedUnitIds);
                  exportToExcel(
                    "vybrannye-edinitsy.xlsx",
                    (unitsQuery.data ?? [])
                      .filter((u) => chosen.has(u.id))
                      .map((u) => ({
                        id: u.id,
                        kind: u.is_strip ? "штрипс" : "рулон",
                        material: skuLabel(u.material_sku),
                        width_mm: u.width_mm,
                        length_m: u.length_m,
                        status: u.status.replace(/_/g, " "),
                        location: u.location_code ?? (u.area ? areaLabel(u.area) : "") ?? "",
                      })),
                    [
                      { key: "id", header: "ID" },
                      { key: "kind", header: "Тип" },
                      { key: "material", header: "Материал" },
                      { key: "width_mm", header: "Ширина, мм" },
                      { key: "length_m", header: "Длина, м" },
                      { key: "status", header: "Статус" },
                      { key: "location", header: "Адрес/участок" },
                    ],
                  );
                };

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
    if (supplierFilter && overviewByGroup.get(`${p.material}|${p.color}|${p.thickness}`)?.usual_supplier !== supplierFilter) {
      return false;
    }
    if (textQuery && !`${p.material} ${p.color}`.toLowerCase().includes(textQuery)) return false;
    if (rollsFilter) {
      const rolls = rollsVsStripsByGroup.get(`${p.material}|${p.color}|${p.thickness}`)?.roll_count ?? 0;
      if (rollsFilter === "any" ? rolls < 1 : rolls > Number(rollsFilter)) return false;
    }
    return true;
  });

  const groupedPositions = useMemo(() => {
    const groups = new Map<string, { material: string; color: string; lines: StockSummaryLine[] }>();

    for (const p of filteredPositions) {
      const key = `${p.material}||${p.color}`;
      let g = groups.get(key);
      if (!g) {
        g = { material: p.material, color: p.color, lines: [] };
        groups.set(key, g);
      }
      g.lines.push(p);
    }

    const rows: GroupedStockLine[] = [];
    for (const [, g] of groups) {
      g.lines.sort((a, b) => a.thickness - b.thickness);
      const allThs = g.lines.map((l) => l.thickness);

      if (g.lines.length === 1) {
        const p = g.lines[0];
        const rvs = rollsVsStripsByGroup.get(`${p.material}|${p.color}|${p.thickness}`);
        const o = overviewByGroup.get(`${p.material}|${p.color}|${p.thickness}`);
        rows.push({
          key: `${p.material}-${p.color}-${p.thickness}`,
          material: p.material,
          color: p.color,
          thickness: p.thickness,
          isParent: false,
          thicknesses: [p.thickness],
          total_area_m2: p.total_area_m2,
          unit_count: p.unit_count,
          value_rub: p.value_rub,
          unpriced_area_m2: p.unpriced_area_m2,
          illiquid_area_m2: p.illiquid_area_m2,
          roll_count: rvs?.roll_count ?? 0,
          roll_length_m: rvs?.roll_length_m ?? 0,
          strip_count: rvs?.strip_count ?? 0,
          strip_length_m: rvs?.strip_length_m ?? 0,
          reserved_area_m2: o?.reserved_area_m2,
          panel_demand_m2: o?.panel_demand_m2,
          open_requested_area_m2: o?.open_requested_area_m2,
          min_stock_m2: o?.min_stock_m2,
          min_batch_m2: o?.min_batch_m2,
          batch_multiple_m2: o?.batch_multiple_m2,
          to_order_m2: o?.to_order_m2,
          shortage_m2: o?.shortage_m2,
          shortage_tasks_m2: o?.shortage_tasks_m2,
          shortage_min_m2: o?.shortage_min_m2,
          usual_supplier: o?.usual_supplier,
          days_of_stock_remaining: o?.days_of_stock_remaining,
          reorder_suggested: o?.reorder_suggested,
        });
      } else {
        let totalArea = 0;
        let totalUnits = 0;
        let totalValue: number | null = null;
        let totalUnpriced = 0;
        let totalIlliquid = 0;
        let totalRolls = 0;
        let totalRollLen = 0;
        let totalStrips = 0;
        let totalStripLen = 0;
        let totalReserved = 0;
        let totalPanelDemand = 0;
        let totalOpenReq = 0;
        let totalToOrder = 0;
        let totalShortage = 0;
        let minDays: number | null = null;
        let anyReorder = false;

        const children: GroupedStockLine[] = [];
        for (const p of g.lines) {
          const rvs = rollsVsStripsByGroup.get(`${p.material}|${p.color}|${p.thickness}`);
          const o = overviewByGroup.get(`${p.material}|${p.color}|${p.thickness}`);
          const rc = rvs?.roll_count ?? 0;
          const rl = rvs?.roll_length_m ?? 0;
          const sc = rvs?.strip_count ?? 0;
          const sl = rvs?.strip_length_m ?? 0;
          const res = o?.reserved_area_m2 ?? 0;
          const pan = o?.panel_demand_m2 ?? 0;
          const req = o?.open_requested_area_m2 ?? 0;
          const toOrd = o?.to_order_m2 ?? 0;
          const sh = o?.shortage_m2 ?? 0;

          totalArea += p.total_area_m2;
          totalUnits += p.unit_count;
          if (p.value_rub != null) {
            totalValue = (totalValue ?? 0) + p.value_rub;
          }
          totalUnpriced += p.unpriced_area_m2 ?? 0;
          totalIlliquid += p.illiquid_area_m2 ?? 0;
          totalRolls += rc;
          totalRollLen += rl;
          totalStrips += sc;
          totalStripLen += sl;
          totalReserved += res;
          totalPanelDemand += pan;
          totalOpenReq += req;
          totalToOrder += toOrd;
          totalShortage += sh;
          if (o?.days_of_stock_remaining != null) {
            minDays = minDays == null ? o.days_of_stock_remaining : Math.min(minDays, o.days_of_stock_remaining);
          }
          if (o?.reorder_suggested) anyReorder = true;

          children.push({
            key: `${p.material}-${p.color}-${p.thickness}`,
            material: p.material,
            color: p.color,
            thickness: p.thickness,
            isParent: false,
            isChild: true,
            thicknesses: [p.thickness],
            total_area_m2: p.total_area_m2,
            unit_count: p.unit_count,
            value_rub: p.value_rub,
            unpriced_area_m2: p.unpriced_area_m2,
            illiquid_area_m2: p.illiquid_area_m2,
            roll_count: rc,
            roll_length_m: rl,
            strip_count: sc,
            strip_length_m: sl,
            reserved_area_m2: o?.reserved_area_m2,
            panel_demand_m2: o?.panel_demand_m2,
            open_requested_area_m2: o?.open_requested_area_m2,
            min_stock_m2: o?.min_stock_m2,
            min_batch_m2: o?.min_batch_m2,
            batch_multiple_m2: o?.batch_multiple_m2,
            to_order_m2: o?.to_order_m2,
            shortage_m2: o?.shortage_m2,
            shortage_tasks_m2: o?.shortage_tasks_m2,
            shortage_min_m2: o?.shortage_min_m2,
            usual_supplier: o?.usual_supplier,
            days_of_stock_remaining: o?.days_of_stock_remaining,
            reorder_suggested: o?.reorder_suggested,
          });
        }

        rows.push({
          key: `group-${g.material}-${g.color}`,
          material: g.material,
          color: g.color,
          isParent: true,
          thicknesses: allThs,
          total_area_m2: Math.round(totalArea * 100) / 100,
          unit_count: totalUnits,
          value_rub: totalValue != null ? Math.round(totalValue) : null,
          unpriced_area_m2: Math.round(totalUnpriced * 100) / 100,
          illiquid_area_m2: Math.round(totalIlliquid * 100) / 100,
          roll_count: totalRolls,
          roll_length_m: Math.round(totalRollLen * 10) / 10,
          strip_count: totalStrips,
          strip_length_m: Math.round(totalStripLen * 10) / 10,
          reserved_area_m2: totalReserved > 0 ? Math.round(totalReserved * 100) / 100 : undefined,
          panel_demand_m2: totalPanelDemand > 0 ? Math.round(totalPanelDemand * 100) / 100 : undefined,
          open_requested_area_m2: totalOpenReq > 0 ? Math.round(totalOpenReq * 100) / 100 : undefined,
          to_order_m2: totalToOrder > 0 ? Math.round(totalToOrder * 100) / 100 : undefined,
          shortage_m2: totalShortage > 0 ? Math.round(totalShortage * 100) / 100 : undefined,
          days_of_stock_remaining: minDays,
          reorder_suggested: anyReorder,
          children,
        });
      }
    }

    return rows;
  }, [filteredPositions, rollsVsStripsByGroup, overviewByGroup]);

  const displayedUnits = (unitsQuery.data ?? []).filter((u) => {
    if (donorOnly) {
      const key = `${u.material_sku.material.name}|${u.material_sku.color.name}|${u.material_sku.thickness.value_mm}|${u.width_mm}`;
      if (!(u.status === "На_хранении" && classCKeys.has(key))) return false;
    }
    if (textQuery) {
      const label = `${u.material_sku.material.name} ${u.material_sku.color.name} ${u.material_sku.manufacturer.name}`.toLowerCase();
      if (!label.includes(textQuery)) return false;
    }
    return true;
  });

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Материалы"
        extra={
          <Space>
            {canCut && <Button onClick={() => setBulkCutOpen(true)}>Списать метраж</Button>}
            {canCreatePosition && (
              <Dropdown
                menu={{
                  items: [
                    ...(canCreatePosition ? [{ key: "position", label: "Материал — позиция без рулона" }] : []),
                    ...(canReceive ? [{ key: "unit", label: "Единица плёнки — один рулон/штрипс вне сессии" }] : []),
                  ],
                  onClick: ({ key }) => (key === "position" ? setCreatePositionOpen(true) : setCreateUnitOpen(true)),
                }}
              >
                <Button type="primary">
                  + Новое <DownOutlined />
                </Button>
              </Dropdown>
            )}
          </Space>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Input
            size="large"
            // enterKeyHint — на этой странице ниже есть ещё несколько
            // текстовых полей (Материал/Цвет/Толщина), и на планшете
            // (Android) виртуальная клавиатура в такой ситуации по
            // умолчанию показывает "Далее" вместо "Найти" — Enter просто
            // переводит фокус на следующее поле, ни разу не вызывая
            // onPressEnter (баг: ввод ID на "Остатках" не искал единицу, а
            // фокус утекал в фильтры — выглядело как "просит материал").
            enterKeyHint="search"
            prefix={<SearchOutlined />}
            placeholder="Введите ID единицы (переход в карточку) или название материала…"
            value={globalQuery}
            onChange={(e) => setGlobalQuery(e.target.value)}
            onPressEnter={runGlobalSearch}
          />

          <Space wrap>
            {!mode && (
              <Radio.Group value={viewMode} onChange={(e) => setViewMode(e.target.value)}>
                <Radio.Button value="positions">По позициям материала</Radio.Button>
                <Radio.Button value="units">По физическим единицам</Radio.Button>
              </Radio.Group>
            )}
            {viewMode === "positions" && (
              <>
                <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
                  Показывать архивные
                </Checkbox>
                {warehousePicker}
              </>
            )}
            {canManageAbc && (
              <Button onClick={() => recomputeMutation.mutate()} loading={recomputeMutation.isPending}>
                Пересчитать ABC
              </Button>
            )}
            {lastRecomputed && (
              <Typography.Text type="secondary">
                Классы пересчитаны: {fmtDateTime(lastRecomputed)}
              </Typography.Text>
            )}
          </Space>

          <Space wrap>
            <DictAutoComplete kind="materials" placeholder="Материал" value={filters.material} onChange={(v) => setFilter("material", v || undefined)} allowCreate={false} />
            <DictAutoComplete kind="colors" placeholder="Цвет" value={filters.color} onChange={(v) => setFilter("color", v || undefined)} allowCreate={false} />
            <InputNumber placeholder="Толщина, мм" min={0} step={0.01} value={filters.thickness} onChange={(v) => setFilter("thickness", v ?? undefined)} />
            <DictAutoComplete kind="manufacturers" placeholder="Производитель" value={filters.manufacturer} onChange={(v) => setFilter("manufacturer", v || undefined)} allowCreate={false} />
            {viewMode === "positions" && (
              <Select
                placeholder="Рулонов на складе"
                allowClear
                style={{ width: 200 }}
                value={rollsFilter}
                onChange={(v) => setRollsFilter(v ?? null)}
                options={[
                  { value: "0", label: "Рулонов нет" },
                  { value: "1", label: "Рулонов: 1 и меньше" },
                  { value: "2", label: "Рулонов: 2 и меньше" },
                  { value: "3", label: "Рулонов: 3 и меньше" },
                  { value: "5", label: "Рулонов: 5 и меньше" },
                  { value: "any", label: "Есть рулоны" },
                ]}
              />
            )}
            {viewMode === "units" && (
              <>
                <Segmented
                  value={unitKind}
                  onChange={(v) => setUnitKind(v as "all" | "roll" | "strip")}
                  options={[
                    { label: "Все", value: "all" },
                    { label: "Рулоны", value: "roll" },
                    { label: "Штрипсы", value: "strip" },
                  ]}
                />
                <Select
                  style={{ width: 170 }}
                  value={illiquidFilter}
                  onChange={setIlliquidFilter}
                  options={[
                    { value: "all", label: "Неликвид: все" },
                    { value: "only", label: "Только неликвид" },
                    { value: "none", label: "Без неликвида" },
                  ]}
                />
                <InputNumber placeholder="Ширина, мм" min={1} value={filters.width_mm} onChange={(v) => setFilter("width_mm", v ?? undefined)} />
                <InputNumber placeholder="Мин. длина, м" min={0} step={0.1} value={filters.min_length_m} onChange={(v) => setFilter("min_length_m", v ?? undefined)} />
                <Select placeholder="Статус" allowClear style={{ width: 160 }} options={statusOptions} value={filters.status} onChange={(v) => setFilter("status", v)} />
                <Select placeholder="Участок" allowClear style={{ width: 180 }} options={areaOptions} value={filters.area} onChange={(v) => setFilter("area", v)} />
                {warehousePicker}
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
            <Space>
            {canOrderFilm && (
              <Button icon={<ShoppingCartOutlined />} type={cart.length ? "primary" : "default"} onClick={() => setCartOpen(true)}>
                Корзина{cart.length ? ` (${cart.length})` : ""}
              </Button>
            )}
            {canOrderFilm && <FilmCartDrawer open={cartOpen} onClose={() => setCartOpen(false)} widthsByFilm={widthsByFilm} />}
            <Button
              icon={<FileExcelOutlined />}
              onClick={() =>
                exportToExcel(
                  "ostatki-po-pozitsiyam.xlsx",
                  filteredPositions.map((r) => {
                    const rvs = rollsVsStripsByGroup.get(`${r.material}|${r.color}|${r.thickness}`);
                    return {
                      ...r,
                      roll_count: rvs?.roll_count ?? 0,
                      roll_length_m: rvs?.roll_length_m ?? 0,
                      strip_count: rvs?.strip_count ?? 0,
                      strip_length_m: rvs?.strip_length_m ?? 0,
                    };
                  }),
                  [
                    { key: "material", header: "Материал" },
                    { key: "color", header: "Цвет" },
                    { key: "thickness", header: "Толщина, мм" },
                    { key: "total_area_m2", header: "Остаток, м²" },
                    ...(canSeePrice ? [{ key: "value_rub" as const, header: "Стоимость, ₽" }] : []),
                    { key: "unit_count", header: "Единиц" },
                    { key: "roll_count", header: "Рулонов, шт" },
                    { key: "roll_length_m", header: "Рулонов, м" },
                    { key: "strip_count", header: "Штрипсов, шт" },
                    { key: "strip_length_m", header: "Штрипсов, м" },
                  ],
                )
              }
            >
              Excel
            </Button>
            </Space>
          }
        >
          {supplierFilter && (
            <Space style={{ marginBottom: 12 }}>
              <Tag color="purple">Только «{supplierFilter}»</Tag>
              <Button size="small" onClick={() => setSupplierFilter(null)}>
                Сбросить фильтр
              </Button>
            </Space>
          )}
          <Table<GroupedStockLine>
            rowKey="key"
            loading={positionsQuery.isLoading}
            dataSource={groupedPositions}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
            onRow={(r) => ({
              style: { cursor: "pointer" },
              onClick: () => {
                if (r.thickness != null) {
                  navigate("/materials", { state: { material: r.material, color: r.color, thickness: r.thickness } });
                } else {
                  navigate("/materials", { state: { material: r.material, color: r.color } });
                }
              },
            })}
            columns={[
              {
                title: "Материал и цвет",
                fixed: "left",
                render: (_, r) => {
                  if (r.isParent) {
                    return (
                      <Space orientation="vertical" size={2}>
                        <Typography.Text strong style={{ fontSize: 15 }}>
                          {r.material}, {r.color}
                        </Typography.Text>
                        <Tag color="blue" style={{ width: "fit-content" }}>
                          Вариантов толщины: {r.thicknesses.length} ({r.thicknesses.map((t) => `${t} мм`).join(", ")})
                        </Tag>
                      </Space>
                    );
                  }
                  if (r.isChild) {
                    return (
                      <span style={{ paddingLeft: 8, color: "#1677ff", fontWeight: 500 }}>
                        ↳ Толщина: {r.thickness} мм
                      </span>
                    );
                  }
                  return `${r.material}, ${r.color}, ${r.thickness} мм`;
                },
                sorter: (a, b) => `${a.material} ${a.color}`.localeCompare(`${b.material} ${b.color}`),
              },
              {
                title: "Остаток, м²",
                dataIndex: "total_area_m2",
                sorter: (a, b) => a.total_area_m2 - b.total_area_m2,
                render: (v: number, r) => (
                  <Space orientation="vertical" size={0}>
                    <span style={{ fontWeight: r.isParent ? 600 : 400 }}>{v}</span>
                    {(r.illiquid_area_m2 ?? 0) > 0 && (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        в т.ч. неликвид {r.illiquid_area_m2}
                      </Typography.Text>
                    )}
                  </Space>
                ),
              },
              ...(canSeePrice
                ? [
                    {
                      title: "Стоимость, ₽",
                      sorter: (a: GroupedStockLine, b: GroupedStockLine) => (a.value_rub ?? 0) - (b.value_rub ?? 0),
                      render: (_: unknown, r: GroupedStockLine) => (
                        <Space orientation="vertical" size={0}>
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: r.isParent ? 600 : 400 }}>
                            {r.value_rub != null ? rub(r.value_rub) : "—"}
                          </span>
                          {(r.unpriced_area_m2 ?? 0) > 0 && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              без цены {Math.round(r.unpriced_area_m2! * 10) / 10} м²
                            </Typography.Text>
                          )}
                        </Space>
                      ),
                    },
                  ]
                : []),
              {
                title: "Единиц",
                dataIndex: "unit_count",
                sorter: (a, b) => a.unit_count - b.unit_count,
                render: (v: number, r) => <span style={{ fontWeight: r.isParent ? 600 : 400 }}>{v}</span>,
              },
              {
                title: "Рулонов",
                sorter: (a, b) => a.roll_count - b.roll_count,
                render: (_, r) => (r.roll_count > 0 ? `${r.roll_count} шт · ${r.roll_length_m} м` : "—"),
              },
              {
                title: "Штрипсов",
                render: (_, r) => (r.strip_count > 0 ? `${r.strip_count} шт · ${r.strip_length_m} м` : "—"),
              },
              ...(canViewPurchasing
                ? [
                    {
                      title: "Резерв на задания, м²",
                      render: (_: unknown, r: GroupedStockLine) => (
                        <>
                          {r.reserved_area_m2 ?? 0}
                          {(r.panel_demand_m2 ?? 0) > 0 && (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {" "}
                              (в т.ч. под двери {r.panel_demand_m2})
                            </Typography.Text>
                          )}
                        </>
                      ),
                    },
                    {
                      title: "Доступно, м²",
                      render: (_: unknown, r: GroupedStockLine) => {
                        const reserved = r.reserved_area_m2 ?? 0;
                        const available = Math.round((r.total_area_m2 - (r.illiquid_area_m2 ?? 0) - reserved) * 10) / 10;
                        return (
                          <Tag color={available < 0 ? "red" : reserved > 0 && available < reserved * 0.2 ? "gold" : "green"}>
                            {available}
                          </Tag>
                        );
                      },
                    },
                    {
                      title: "В заявках",
                      render: (_: unknown, r: GroupedStockLine) => {
                        const v = r.open_requested_area_m2 ?? 0;
                        return v > 0 ? <Tag color="purple">{v} м²</Tag> : "—";
                      },
                    },
                    {
                      title: "Нормативы / заказать, м²",
                      render: (_: unknown, r: GroupedStockLine) => {
                        if (r.isParent) {
                          return (r.to_order_m2 ?? 0) > 0 ? (
                            <Tag color="orange">заказать {r.to_order_m2}</Tag>
                          ) : (
                            <Tag color="green">хватает</Tag>
                          );
                        }
                        const label = normsLabel(r.min_stock_m2, r.min_batch_m2, r.batch_multiple_m2);
                        return (
                          <Space orientation="vertical" size={0}>
                            {label !== "—" && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>}
                            {(r.to_order_m2 ?? 0) > 0 ? (
                              <Space size={4} wrap>
                                <Tag color="orange">заказать {r.to_order_m2}</Tag>
                                <ShortageTags total={r.shortage_m2 ?? 0} tasks={r.shortage_tasks_m2} min={r.shortage_min_m2} />
                              </Space>
                            ) : label === "—" ? "—" : <Tag color="green">хватает</Tag>}
                          </Space>
                        );
                      },
                    },
                    {
                      title: "Обычно берут у",
                      render: (_: unknown, r: GroupedStockLine) => r.usual_supplier ?? "—",
                    },
                    {
                      title: "Хватит на, дн.",
                      render: (_: unknown, r: GroupedStockLine) =>
                        r.days_of_stock_remaining == null ? (
                          "—"
                        ) : (
                          <Tag color={r.reorder_suggested ? "orange" : undefined}>{r.days_of_stock_remaining}</Tag>
                        ),
                    },
                  ]
                : []),
              ...(canOrderFilm
                ? [
                    {
                      title: "Заказать, м",
                      width: 190,
                      render: (_: unknown, r: GroupedStockLine) => {
                        if (r.isParent || r.thickness == null) return null;
                        const k = `${r.material}|${r.color}|${r.thickness}`;
                        const width = widthsByFilm.get(k)?.widths[0] ?? null;
                        const toOrderM2 = r.to_order_m2 ?? 0;
                        return (
                          <OrderToCart
                            inCart={cart.filter((l) => filmKey(l) === k).reduce((sum, l) => sum + l.length_m, 0)}
                            suggested={toOrderM2 > 0 && width ? Math.ceil((toOrderM2 * 1000) / width) : null}
                            onAdd={(m) => {
                              filmCart.add({ material: r.material, color: r.color, thickness: r.thickness!, width_mm: width, length_m: m });
                              message.success(`В корзине: ${r.material}, ${r.color} — +${m} м`);
                            }}
                          />
                        );
                      },
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      ) : (
        <Card
          extra={
            <Button
              icon={<FileExcelOutlined />}
              onClick={() =>
                exportToExcel(
                  "ostatki-po-edinitsam.xlsx",
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
              Excel
            </Button>
          }
        >
          {(unitsQuery.data?.length ?? 0) >= UNIT_SEARCH_LIMIT && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`Показаны первые ${UNIT_SEARCH_LIMIT} единиц — сузьте отбор (материал, ширина, статус…), чтобы увидеть остальные.`}
            />
          )}
          {selectedUnitIds.length > 0 && (
            <Space wrap style={{ marginBottom: 12 }}>
              <Typography.Text>Выбрано: {selectedUnitIds.length}</Typography.Text>
              {canEditUnit && <Button onClick={() => setBulkEditOpen(true)}>Изменить выбранные…</Button>}
              <Button onClick={() => printLabelsBatch(selectedUnitIds)}>Печать этикеток</Button>
              <Dropdown
                menu={{
                  items: [
                    ...(canIssue ? [{ key: "issue", label: "Выдать участку…" }] : []),
                    ...(canReturn ? [{ key: "return", label: "Вернуть на склад…" }] : []),
                    ...(canTransfer ? [{ key: "transfer", label: "Переместить на другой склад…" }] : []),
                    ...(canIssue ? [{ key: "link", label: "Привязать к строке задания…" }] : []),
                    ...(canMarkIlliquid
                      ? [
                          { key: "illiquid-on", label: "Пометить неликвидом…" },
                          { key: "illiquid-off", label: "Снять пометку неликвид" },
                        ]
                      : []),
                    { key: "export", label: "Экспорт выбранных в Excel" },
                    ...(canWriteOff
                      ? [
                          { type: "divider" as const },
                          { key: "writeoff", label: "Списать выбранные…", danger: true },
                          { key: "delete", label: user?.is_superuser ? "Удалить выбранные…" : "Запросить удаление…", danger: true },
                        ]
                      : []),
                  ],
                  onClick: ({ key }) => {
                    if (key === "export") exportSelected();
                    else if (key === "illiquid-on" || key === "illiquid-off") markIlliquid(key === "illiquid-on");
                    else if (key === "writeoff") setWriteOffOpen(true);
                    else setBulkAction(key as BulkAction);
                  },
                }}
              >
                <Button>
                  Ещё действия <DownOutlined />
                </Button>
              </Dropdown>
              <Button type="link" onClick={() => setSelectedUnitIds([])}>
                Снять выбор
              </Button>
            </Space>
          )}
          <ResponsiveTable<MaterialUnit>
            tableKey="materials-explorer-units"
            lockedColumns={["ID", "Материал"]}
            stickyColumns={2}
            cardBreakpoint="sm"
            rowKey="id"
            loading={unitsQuery.isLoading}
            dataSource={displayedUnits}
            pagination={{ pageSize: 20 }}
            scroll={{ x: "max-content" }}
            // Выбор строк — всем: печать и экспорт доступны любому, кто видит остатки.
            rowSelection={{ selectedRowKeys: selectedUnitIds, onChange: (keys) => setSelectedUnitIds(keys as number[]) }}
            onRow={(u) => ({
              onClick: (e) => {
                if ((e.target as HTMLElement).closest(".ant-checkbox-wrapper")) return;
                navigate("/m/unit-card", { state: { unitId: u.id } });
              },
            })}
            columns={[
              {
                title: "ID",
                dataIndex: "id",
                sorter: (a, b) => a.id - b.id,
                render: (v: number, u) => (
                  <Space size={4}>
                    {rollNo(v)}
                    {u.marked_illiquid && <Tag color="orange" style={{ margin: 0 }}>неликвид</Tag>}
                  </Space>
                ),
              },
              { title: "Материал", render: (_, u) => skuLabel(u.material_sku) },
              { title: "Тип", render: (_, u) => (u.is_strip ? "штрипс" : "рулон") },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м`, sorter: (a, b) => a.width_mm - b.width_mm },
              { title: "Статус", render: (_, u) => u.status.replace(/_/g, " ") },
              { title: "Склад", render: (_, u) => u.warehouse_name ?? "—" },
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
                render: (_, u) => (
                  <Space size={4} onClick={(e) => e.stopPropagation()}>
                    {/* переместить / вернуть / списать / скорректировать — единое окно (06.10) */}
                    <LotActions lot={lotFromUnit(u)} />
                    {canEditUnit && (
                      <Button size="small" onClick={() => setReassignTarget(u)}>
                        Изменить
                      </Button>
                    )}
                    {canWriteOff && (
                      <Button
                        size="small"
                        danger
                        loading={deleteUnitMutation.isPending}
                        onClick={() => deleteUnitMutation.mutate(u.id)}
                      >
                        {user?.is_superuser ? "Удалить" : "Запросить удаление"}
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal title="Новая позиция материала" open={createPositionOpen} onCancel={() => setCreatePositionOpen(false)} footer={null} destroyOnHidden>
        <Typography.Paragraph type="secondary">Без физического рулона — например, под будущую поставку.</Typography.Paragraph>
        <Form form={positionForm} layout="vertical" onFinish={(v) => createPositionMutation.mutate(v)}>
          <Form.Item style={{ marginBottom: 16 }}>
            <ExistingSkuPicker
              onSelect={(sku) =>
                positionForm.setFieldsValue({
                  material: sku.material.name,
                  color: sku.color.name,
                  thickness: sku.thickness.value_mm,
                  manufacturer: sku.manufacturer.name,
                })
              }
            />
          </Form.Item>
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
        title="Постановка на учёт вне сессии приёмки"
        open={createUnitOpen}
        onCancel={() => {
          setCreateUnitOpen(false);
          setCreatedUnits([]);
        }}
        footer={null}
        destroyOnHidden
        width={660}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Быстрая регистрация рулонов или штрипсов — остатки со склада, неликвид, рулоны без документов.
          Можно зарегистрировать сразу партию из N одинаковых рулонов с печатью всех бирок.
        </Typography.Paragraph>
        <Form
          form={unitForm}
          layout="vertical"
          size="middle"
          initialValues={{ is_strip: false, quantity: 1, marked_illiquid: false }}
          onFinish={(v) => createUnitMutation.mutate(v)}
        >
          <Row gutter={12} align="middle" style={{ marginBottom: 12 }}>
            <Col xs={24} sm={12}>
              <Form.Item name="is_strip" label="Форм-фактор" style={{ marginBottom: 0 }}>
                <Radio.Group
                  options={[
                    { label: "Рулон", value: false },
                    { label: "Штрипс", value: true },
                  ]}
                  optionType="button"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="marked_illiquid" valuePropName="checked" label="Статус фонда" style={{ marginBottom: 0 }}>
                <Switch
                  checkedChildren="Неликвид"
                  unCheckedChildren="Основной"
                  style={{ backgroundColor: manualIlliquid ? "#fa8c16" : undefined }}
                />
              </Form.Item>
            </Col>
          </Row>

          {manualIlliquid && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Рулоны будут помечены как «Неликвид»"
              description="Они будут отображаться с оранжевым бейджем и не пойдут в автоматическую выдачу под обычные заказы."
            />
          )}

          <Form.Item style={{ marginBottom: 12 }}>
            <ExistingSkuPicker
              placeholder="Найти существующую позицию (автозаполнение полей)…"
              onSelect={(sku) =>
                unitForm.setFieldsValue({
                  material: sku.material.name,
                  color: sku.color.name,
                  thickness: sku.thickness.value_mm,
                  manufacturer: sku.manufacturer.name,
                })
              }
            />
          </Form.Item>

          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="material" label="Материал" rules={[{ required: true, message: "Укажите материал" }]}>
                <DictAutoComplete kind="materials" placeholder="ПВХ, ПЭТ..." />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="color" label="Цвет" rules={[{ required: true, message: "Укажите цвет" }]}>
                <DictAutoComplete kind="colors" placeholder="Дуб Золотой..." />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true, message: "Укажите толщину" }]}>
                <InputNumber min={0.01} step={0.01} style={{ width: "100%" }} placeholder="0.18" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="manufacturer"
                label="Производитель (необязательно)"
                tooltip="Если неизвестен или без документов — сохранится как «Не указан»"
              >
                <DictAutoComplete kind="manufacturers" placeholder="Не указан" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col xs={24} sm={8}>
              <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true, message: "Укажите ширину" }]}>
                <InputNumber min={1} style={{ width: "100%" }} placeholder="1400" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="length_m" label="Длина, м" rules={[{ required: true, message: "Укажите длину" }]}>
                <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} placeholder="280" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item name="quantity" label="Количество рулонов" rules={[{ required: true, message: "Минимум 1" }]}>
                <InputNumber min={1} max={200} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={8} style={{ marginBottom: 12 }}>
            {[1, 2, 5, 10, 11].map((num) => (
              <Col key={num} span={4}>
                <Button block size="small" onClick={() => unitForm.setFieldValue("quantity", num)}>
                  {num} шт
                </Button>
              </Col>
            ))}
          </Row>

          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="upd_number" label="Номер УПД (необязательно)">
                <Input placeholder="Без документа" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="pallet_number" label="Номер паллеты / упаковки (необязательно)">
                <Input placeholder="—" />
              </Form.Item>
            </Col>
          </Row>

          <OccurredAtField label="Дата приёмки (необязательно — по умолчанию сейчас)" />

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            style={{ height: 44, fontSize: 16 }}
            loading={createUnitMutation.isPending}
          >
            Зарегистрировать {manualQty && manualQty > 1 ? `(${manualQty} шт.)` : ""}
          </Button>
        </Form>

        {createdUnits.length > 0 && (
          <Card
            size="small"
            style={{ marginTop: 16, background: "#f6ffed", borderColor: "#b7eb8f" }}
          >
            <Space direction="vertical" style={{ width: "100%" }} size={8}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography.Text strong style={{ color: "#389e0d" }}>
                  Успешно создано: {createdUnits.length} шт.
                </Typography.Text>
                <Button
                  type="primary"
                  size="small"
                  onClick={() => printLabelsBatch(createdUnits.map((u) => u.id))}
                >
                  Печать всех бирок ({createdUnits.length})
                </Button>
              </div>
              <List
                size="small"
                bordered
                dataSource={createdUnits}
                pagination={createdUnits.length > 5 ? { pageSize: 5, size: "small" } : false}
                renderItem={(u) => (
                  <List.Item
                    actions={[
                      <Button key="print" size="small" onClick={() => printLabel(u.id)}>
                        Печать
                      </Button>,
                    ]}
                  >
                    <span>
                      <b>№ {rollNo(u.id)}</b> — {u.width_mm}×{u.length_m} м, {u.location_code ?? "без места"}
                      {u.marked_illiquid && (
                        <Tag color="orange" style={{ marginLeft: 6 }}>
                          неликвид
                        </Tag>
                      )}
                    </span>
                  </List.Item>
                )}
              />
            </Space>
          </Card>
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
          <OccurredAtField />
        </Form>
      </Modal>

      {reassignTarget && <UnitEditModal unit={reassignTarget} onClose={() => setReassignTarget(null)} />}
      {bulkAction && (
        <UnitBulkActionModal
          action={bulkAction}
          units={(unitsQuery.data ?? []).filter((u) => selectedUnitIds.includes(u.id))}
          isSuperuser={!!user?.is_superuser}
          onClose={() => setBulkAction(null)}
          onDone={() => setSelectedUnitIds([])}
        />
      )}
      {bulkEditOpen && (
        <UnitBulkEditModal unitIds={selectedUnitIds} onClose={() => setBulkEditOpen(false)} onDone={() => setSelectedUnitIds([])} />
      )}
      {bulkCutOpen && <BulkCutModal onClose={() => setBulkCutOpen(false)} />}
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
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku.id, is_strip: unit.is_strip }),
  });
  const placeMutation = useMutation({
    mutationFn: (locationCode: string) => placeUnit(unit.id, locationCode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["materials-explorer", "units"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      message.success(`${rollNo(unit.id)} размещён`);
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

const CUTTABLE_STATUSES: readonly string[] = ["На_хранении", "Выдан_участку"];

/** Массовое списание метража (раздел про выдачу плёнки в производство) —
 * добавление по одной единице через поиск по номеру, затем клиентский цикл
 * по одиночному cutUnit, тот же паттерн, что bulkWriteOffMutation выше:
 * backend-эндпоинт под пакетное списание отдельно не заводили. */
function BulkCutModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [lookupId, setLookupId] = useState<number>();
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [foundUnit, setFoundUnit] = useState<MaterialUnit | null>(null);
  const [cutLength, setCutLength] = useState<number>();
  const [queue, setQueue] = useState<{ unit: MaterialUnit; cutLengthM: number }[]>([]);
  const [results, setResults] = useState<{ id: number; before: number; after: number }[]>([]);
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const lookupMutation = useMutation({
    mutationFn: (id: number) => getUnit(id),
    onSuccess: (unit) => {
      if (!CUTTABLE_STATUSES.includes(unit.status)) {
        setLookupError(`${rollNo(unit.id)}: статус «${unit.status.replace(/_/g, " ")}» — раскрой недоступен`);
        setFoundUnit(null);
        return;
      }
      if (queue.some((q) => q.unit.id === unit.id)) {
        setLookupError(`${rollNo(unit.id)} уже в списке — уберите строку, чтобы изменить`);
        setFoundUnit(null);
        return;
      }
      setLookupError(null);
      setFoundUnit(unit);
      setCutLength(undefined);
    },
    onError: () => {
      setLookupError("Единица с таким номером не найдена");
      setFoundUnit(null);
    },
  });

  const addToQueue = () => {
    if (!foundUnit || !cutLength || cutLength <= 0 || cutLength > foundUnit.length_m) return;
    setQueue((q) => [...q, { unit: foundUnit, cutLengthM: cutLength }]);
    setFoundUnit(null);
    setCutLength(undefined);
    setLookupId(undefined);
  };

  const removeFromQueue = (id: number) => setQueue((q) => q.filter((item) => item.unit.id !== id));

  // По одной (19.10): списанная единица сразу уходит из очереди — при ошибке
  // посередине в очереди остаётся только несписанное, повтор не спишет дважды.
  const bulkCutMutation = useMutation({
    mutationFn: async () => {
      const occurredAtIso = toOccurredAtIso(occurredAt);
      const processed: { id: number; before: number; after: number }[] = [];
      for (const item of queue) {
        try {
          const updated = await cutUnit(item.unit.id, { cut_length_m: item.cutLengthM, occurred_at: occurredAtIso });
          processed.push({ id: updated.id, before: item.unit.length_m, after: updated.length_m });
          setQueue((q) => q.filter((x) => x.unit.id !== item.unit.id));
        } catch (e) {
          return { processed, failed: { id: item.unit.id, error: apiErrorMessage(e, "ошибка") } };
        }
      }
      return { processed, failed: null };
    },
    onSuccess: ({ processed, failed }) => {
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      setResults(processed);
      if (failed)
        message.error(`Списано с ${processed.length}; остановлено на ${rollNo(failed.id)}: ${failed.error}. Остальные — в списке, можно повторить`);
      else message.success(`Списано с ${processed.length} единиц`);
    },
  });

  return (
    <Modal title="Списать метраж с рулонов/штрипсов" open onCancel={onClose} footer={null} width={560} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Уменьшает длину конкретной единицы на месте (без создания новой) — для метража, фактически израсходованного
        при выдаче в производство. Доступно для единиц «На хранении» или уже «Выдан участку».
      </Typography.Paragraph>

      <div style={{ marginBottom: 12 }}>
        <Typography.Text>Дата операции для всего списка (необязательно — по умолчанию сейчас)</Typography.Text>
        <DatePicker
          style={{ width: "100%", marginTop: 4 }}
          format="DD.MM.YYYY"
          placeholder="Сейчас"
          value={occurredAt}
          onChange={setOccurredAt}
          disabledDate={(d) => d.isAfter(dayjs(), "day")}
        />
      </div>

      <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
        <InputNumber
          style={{ width: "100%" }}
          placeholder="№ единицы"
          min={1}
          value={lookupId}
          onChange={(v) => setLookupId(v ?? undefined)}
          onPressEnter={() => lookupId && lookupMutation.mutate(lookupId)}
        />
        <Button loading={lookupMutation.isPending} onClick={() => lookupId && lookupMutation.mutate(lookupId)}>
          Найти
        </Button>
      </Space.Compact>

      {lookupError && <Alert style={{ marginBottom: 8 }} type="error" showIcon message={lookupError} />}

      {foundUnit && (
        <Card size="small" style={{ marginBottom: 8 }}>
          <Typography.Text>
            {rollNo(foundUnit.id)} — {skuLabel(foundUnit.material_sku)}, {foundUnit.width_mm}×{foundUnit.length_m} м,{" "}
            {foundUnit.status.replace(/_/g, " ")}
          </Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Space.Compact style={{ width: "100%" }}>
              <InputNumber
                style={{ width: "100%" }}
                placeholder="Списать, м"
                min={0.01}
                max={foundUnit.length_m}
                step={0.1}
                value={cutLength}
                onChange={(v) => setCutLength(v ?? undefined)}
              />
              <Button
                type="primary"
                disabled={!cutLength || cutLength <= 0 || cutLength > foundUnit.length_m}
                onClick={addToQueue}
              >
                Добавить в список
              </Button>
            </Space.Compact>
          </div>
        </Card>
      )}

      {queue.length > 0 && (
        <List
          style={{ marginBottom: 12 }}
          size="small"
          bordered
          header={`К списанию: ${queue.length}`}
          dataSource={queue}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="remove" size="small" danger onClick={() => removeFromQueue(item.unit.id)}>
                  Убрать
                </Button>,
              ]}
            >
              {rollNo(item.unit.id)} — {skuLabel(item.unit.material_sku)}: было {item.unit.length_m} м, спишется{" "}
              {item.cutLengthM} м, останется {(item.unit.length_m - item.cutLengthM).toFixed(2)} м
            </List.Item>
          )}
        />
      )}

      {queue.length > 0 && (
        <Button type="primary" block danger loading={bulkCutMutation.isPending} onClick={() => bulkCutMutation.mutate()}>
          Списать всё ({queue.length})
        </Button>
      )}

      {results.length > 0 && (
        <>
          <List
            style={{ marginTop: 16 }}
            size="small"
            bordered
            header="Обработано"
            dataSource={results}
            renderItem={(r) => (
              <List.Item>
                {rollNo(r.id)} — было {r.before} м, осталось {r.after} м{r.after === 0 && " — списан полностью"}
              </List.Item>
            )}
          />
          {(() => {
            const stillActiveIds = results.filter((r) => r.after > 0).map((r) => r.id);
            return (
              stillActiveIds.length > 0 && (
                <Button style={{ marginTop: 8 }} block onClick={() => printLabelsBatch(stillActiveIds)}>
                  Распечатать бирки с остатком ({stillActiveIds.length})
                </Button>
              )
            );
          })()}
        </>
      )}
    </Modal>
  );
}

/** «Заказать, м» в «Остатках» (22.10): метры рядом с кнопкой, сразу в корзину. */
function OrderToCart({ inCart, suggested, onAdd }: { inCart: number; suggested: number | null; onAdd: (m: number) => void }) {
  const [m, setM] = useState<number | null>(null);
  const value = m ?? suggested;
  return (
    <Space orientation="vertical" size={2} onClick={(e) => e.stopPropagation()}>
      <Space.Compact size="small">
        <InputNumber size="small" min={1} style={{ width: 90 }} placeholder="метров" value={value} onChange={setM} aria-label="Метров заказать" />
        <Button
          size="small"
          icon={<ShoppingCartOutlined />}
          disabled={!value}
          title="В корзину"
          aria-label="В корзину"
          onClick={() => {
            if (!value) return;
            onAdd(value);
            setM(null);
          }}
        >
          В корзину
        </Button>
      </Space.Compact>
      {inCart > 0 && <Tag color="blue" style={{ margin: 0 }}>в корзине {Math.round(inCart * 100) / 100} м</Tag>}
    </Space>
  );
}
