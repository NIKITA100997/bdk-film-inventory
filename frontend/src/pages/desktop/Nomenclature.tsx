import { useMemo, useState } from "react";
import DictionaryAdmin from "./DictionaryAdmin";
import { DIRECTIONS, MODES, STAGES, STAGE_COLOR, toOptions } from "../../utils/itemAttrs";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Checkbox, Input, Modal, Popconfirm, Segmented, Select, Space, Tabs, Tag, TreeSelect, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import TypesTab from "./nomenclature/TypesTab";
import GroupsModal from "./nomenclature/GroupsModal";
import NewModelWizard from "./nomenclature/NewModelWizard";
import QuickShieldDoorModal from "./nomenclature/QuickShieldDoorModal";
import PartParamsModal from "./nomenclature/PartParamsModal";
import { BulkStagesModal, PartDuplicatesModal } from "./nomenclature/PartBulkModals";
import ProductModels from "./ProductModels";
import { useAuth } from "../../auth/AuthContext";
import { listParts } from "../../api/dictionaries";
import {
  createSizeParts,
  groupPath,
  groupTree,
  groupWithDescendants,
  listItemGroups,
  setItemsGroup, setItemsPet, setItemsAttrs,
  linkLines,
  listItemKinds,
  listItems,
  listManualLinks,
  listSizeCandidates,
  listUnlinkedLines,
  unlinkLines,
  type Item,
  type ManualLinkGroup,
  type SizeCandidate,
  type UnlinkedLineGroup,
} from "../../api/items";
import { apiErrorMessage } from "../../utils/apiError";
import { getStockByItem, type ItemStock } from "../../api/unifiedStock";
import { hasPerm } from "../../auth/permissions";
import { DecorThumbnail } from "../../components/DecorThumbnail";

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange", izdelie: "green", material: "cyan" };

/** Номенклатура — одна запись на любую позицию (плёнка, п/ф, изделие…),
 * вид задаёт, в чём она учитывается; здесь же типы с правилами и прежние
 * справочники деталей и моделей (единая модель, 24.09). Вкладка — в адресе
 * (?tab=…): на неё ведут пункты меню и старые адреса /parts, /product-models. */
export default function Nomenclature() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const canConfigure = hasPerm(user, "production_tasks.manage");
  const canDicts = hasPerm(user, "materials.manage");
  const tabs = [
    { key: "items", label: "Номенклатура", children: <ItemsTab /> },
    { key: "types", label: "Типы и правила", children: <TypesTab /> },
    ...(canConfigure
      ? [
          { key: "models", label: "Модели продукции (BOM)", children: <ProductModels /> },
        ]
      : []),
    // Справочники (материалы, цвета, толщины, причины брака…) — вкладкой, не пунктом меню (30.09);
    // служебные «Строки без детали» и «Связанные вручную» — внутри них (27.10)
    ...(canDicts
      ? [
          {
            key: "dicts",
            label: "Справочники",
            children: (
              <Tabs
                size="small"
                items={[
                  { key: "dicts", label: "Справочники", children: <DictionaryAdmin /> },
                  { key: "unlinked", label: "Служебное: строки без детали", children: <UnlinkedTab /> },
                  { key: "manual", label: "Служебное: связанные вручную", children: <ManualLinksTab /> },
                ]}
              />
            ),
          },
        ]
      : []),
  ];
  const active = tabs.some((t) => t.key === params.get("tab")) ? (params.get("tab") as string) : "items";
  return <Tabs activeKey={active} onChange={(k) => setParams(k === "items" ? {} : { tab: k })} items={tabs} destroyOnHidden />;
}

const NO_GROUP = -1;

function ItemsTab() {
  const { user } = useAuth();
  const canGroup = hasPerm(user, "production_tasks.manage", "materials.manage");
  const qc = useQueryClient();
  // ?kind=pf — старый адрес /parts (бывшая вкладка «Детали п/ф») ведёт сюда.
  const [urlParams] = useSearchParams();
  const [kind, setKind] = useState<string>(urlParams.get("kind") ?? "all");
  const [newPartOpen, setNewPartOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [bulkStagesOpen, setBulkStagesOpen] = useState(false);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  // Номенклатура = остатки (27.10): «Только с остатком» — бывшие «Остатки по позициям».
  const [onlyStock, setOnlyStock] = useState(urlParams.get("stock") === "1");
  const [groupByProfile, setGroupByProfile] = useState(true);
  const [place, setPlace] = useState<string | undefined>(urlParams.get("place") ?? undefined);
  const [group, setGroup] = useState<number | undefined>();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [moveTo, setMoveTo] = useState<number | undefined>();
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [direction, setDirection] = useState<string | undefined>();
  const [stage, setStage] = useState<string | undefined>();
  const [attrsOpen, setAttrsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [quickShieldOpen, setQuickShieldOpen] = useState(false);
  const kindsQuery = useQuery({ queryKey: ["item-kinds"], queryFn: listItemKinds });
  const groupsQuery = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const itemsQuery = useQuery({
    queryKey: ["items", includeInactive],
    queryFn: () => listItems({ include_inactive: includeInactive }),
  });
  const stockQuery = useQuery({ queryKey: ["unified-stock", "by-item"], queryFn: getStockByItem });
  const stockOf = useMemo(() => new Map((stockQuery.data ?? []).map((s) => [s.item_id, s])), [stockQuery.data]);
  const placeOptions = useMemo(
    () => [...new Set((stockQuery.data ?? []).flatMap((s) => s.places))].sort().map((p) => ({ value: p, label: p })),
    [stockQuery.data],
  );

  // Модели и профили деталей — строками, их варианты (цвета/декоры) — внутри (дерево).
  // Поиск: подошла модель/профиль — все её варианты; подошёл вариант — родитель с ним.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/ё/g, "е");
    const inGroup = group != null && group !== NO_GROUP ? groupWithDescendants(groups, group) : null;
    const all = itemsQuery.data ?? [];
    const matches = (i: Item) =>
      !needle ||
      i.name.toLowerCase().replace(/ё/g, "е").includes(needle) ||
      (i.code_1c ?? "").toLowerCase().includes(needle) ||
      (i.aliases ?? []).some((a) => a.toLowerCase().replace(/ё/g, "е").includes(needle));
    const stocked = (i: Item) => {
      if (!onlyStock && !place) return true;
      const s = stockOf.get(i.id);
      return !!s && s.qty > 0 && (!place || s.places.includes(place));
    };
    const models = new Set(all.filter((i) => i.is_model).map((i) => i.id));
    const variants = new Map<number, Item[]>();
    for (const i of all) if (i.model_id != null && models.has(i.model_id)) variants.set(i.model_id, [...(variants.get(i.model_id) ?? []), i]);
    const out: ItemRow[] = [];
    const inSelectedGroup = (x: Item) =>
      group == null || (group === NO_GROUP ? x.group_id == null : x.group_id != null && inGroup!.has(x.group_id));

    // 1. Модели ГП (двери со спецификациями)
    const nonModelCandidates: Item[] = [];
    for (const i of all) {
      if (i.model_id != null && models.has(i.model_id)) continue;
      if (kind !== "all" && i.kind_code !== kind) continue;
      if (direction && (direction === "__none" ? i.direction : i.direction !== direction)) continue;
      if (stage && i.stage !== stage) continue;

      if (i.is_model) {
        if (!inSelectedGroup(i) && !(variants.get(i.id) ?? []).some(inSelectedGroup)) continue;
        const own = variants.get(i.id) ?? [];
        const kids = (matches(i) ? own : own.filter(matches)).filter(stocked);
        if ((!matches(i) || ((onlyStock || place) && !stocked(i))) && kids.length === 0) continue;
        out.push({ ...i, variant_count: own.length, children: kids.length ? kids : undefined });
      } else {
        nonModelCandidates.push(i);
      }
    }

    // 2. Если группировка профилей отключена — выводим плоский список
    if (!groupByProfile) {
      for (const i of nonModelCandidates) {
        if (!inSelectedGroup(i)) continue;
        if (matches(i) && stocked(i)) {
          out.push(i);
        }
      }
      return out;
    }

    // 3. Группировка полуфабрикатов и деталей по базовым профилям и декорам
    const itemsById = new Map<number, Item>(all.map((x) => [x.id, x]));
    const bareItemsByName = new Map<string, Item>();
    for (const x of all) {
      const { decorLabel } = parseBaseAndDecor(x.name);
      if (!decorLabel && !x.base_item_id && !x.is_model) {
        bareItemsByName.set(x.name.trim().toLowerCase().replace(/ё/g, "е"), x);
      }
    }

    interface ProfileCluster {
      baseItem?: Item;
      baseName: string;
      items: Array<{ item: Item; decorLabel: string | null }>;
    }
    const clusters = new Map<string, ProfileCluster>();

    for (const item of nonModelCandidates) {
      const { baseName, decorLabel } = parseBaseAndDecor(item.name);
      const baseItem = item.base_item_id
        ? itemsById.get(item.base_item_id)
        : bareItemsByName.get(baseName.trim().toLowerCase().replace(/ё/g, "е"));

      const normBaseName = baseItem ? baseItem.name : baseName;
      const clusterKey = normBaseName.trim().toLowerCase().replace(/ё/g, "е");

      if (!clusters.has(clusterKey)) {
        clusters.set(clusterKey, {
          baseItem,
          baseName: normBaseName,
          items: [],
        });
      }
      clusters.get(clusterKey)!.items.push({ item, decorLabel });
    }

    let virtualIdx = 1;
    for (const cluster of clusters.values()) {
      // Одиночная деталь без декора и без привязки к базе — обычная отдельная строка
      if (cluster.items.length === 1 && !cluster.items[0].decorLabel && !cluster.items[0].item.base_item_id) {
        const solo = cluster.items[0].item;
        if (inSelectedGroup(solo) && matches(solo) && stocked(solo)) {
          out.push(solo);
        }
        continue;
      }

      // Фильтр по группе
      const inGroupItems = cluster.items.filter((entry) => inSelectedGroup(entry.item));
      if (group != null && inGroupItems.length === 0) continue;

      // Поиск: если совпало базовое название — показываем все варианты группы, иначе только совпавшие
      const matchesBase = !needle || cluster.baseName.toLowerCase().replace(/ё/g, "е").includes(needle);
      const matchingEntries = matchesBase
        ? inGroupItems
        : inGroupItems.filter((entry) => matches(entry.item));
      if (matchingEntries.length === 0) continue;

      // Остаток
      const stockedEntries = matchingEntries.filter((entry) => stocked(entry.item));
      if ((onlyStock || place) && stockedEntries.length === 0) continue;

      const effectiveEntries = onlyStock || place ? stockedEntries : matchingEntries;

      // Если в кластере всего 1 позиция без базового профиля — оставляем как отдельную строку
      if (cluster.items.length === 1 && !cluster.baseItem) {
        const solo = effectiveEntries[0].item;
        out.push({
          ...solo,
          decor_label: effectiveEntries[0].decorLabel,
        });
        continue;
      }

      // Формируем дочерние строки вариантов
      const kids: ItemRow[] = effectiveEntries.map((entry) => ({
        ...entry.item,
        decor_label: entry.decorLabel ?? (cluster.baseItem?.id === entry.item.id ? "— без плёнки —" : null),
      }));

      // Мастер-строка профиля
      const masterRow: ItemRow = {
        ...(cluster.baseItem ?? {
          id: -(100000 + virtualIdx++),
          kind_code: cluster.items[0].item.kind_code,
          kind_name: cluster.items[0].item.kind_name,
          unit: cluster.items[0].item.unit,
          name: cluster.baseName,
          code_1c: null,
          is_active: true,
          source_type: null,
          source_id: null,
          group_id: cluster.items[0].item.group_id,
          is_model: false,
          model_id: null,
          material: null,
          color: null,
          thickness: null,
          direction: cluster.items[0].item.direction,
          stage: cluster.items[0].item.stage,
          make_mode: cluster.items[0].item.make_mode,
        }),
        name: cluster.baseName,
        is_profile_group: true,
        variant_count: cluster.items.length,
        children: kids,
      };
      out.push(masterRow);
    }

    return out;
  }, [itemsQuery.data, kind, q, group, groups, direction, stage, onlyStock, place, stockOf, groupByProfile]);

  const petMutation = useMutation({
    mutationFn: (pet: "2d" | "3d") => setItemsPet({ item_ids: selectedIds, pet_type: pet }),
    onSuccess: (r, pet) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      setSelectedIds([]);
      message.success(`ПЭТ ${pet === "3d" ? "3Д" : "2Д"}: ${r.updated}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось проставить ПЭТ")),
  });
  const moveMutation = useMutation({
    mutationFn: (groupId: number | null) => setItemsGroup({ item_ids: selectedIds, group_id: groupId }),
    onSuccess: (r, groupId) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["item-groups"] });
      setSelectedIds([]);
      message.success(groupId == null ? `Убрано из групп: ${r.moved}` : `Перенесено в «${groupPath(groups, groupId)}»: ${r.moved}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось перенести")),
  });
  const kindName = kindsQuery.data?.find((k) => k.code === kind)?.name ?? "";

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of itemsQuery.data ?? []) c[i.kind_code] = (c[i.kind_code] ?? 0) + 1;
    return c;
  }, [itemsQuery.data]);

  const navigate = useNavigate();

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Typography.Paragraph type="secondary">
          Все позиции в одном списке: плёнка, п/ф, изделия. Вид задаёт, в чём позиция учитывается. Клик по строке —
          техкарта: маршрут, состав и где используется (есть схема деревом). «+ Новая модель» — мастер с подсказками:
          тип, модель, варианты и схема до создания. Код 1С заполним при сопоставлении с 1С.
        </Typography.Paragraph>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={kind}
            onChange={(v) => {
              setKind(v as string);
              setGroup(undefined);
              setSelectedIds([]);
              setMoveTo(undefined);
            }}
            options={[
              { label: `Все (${itemsQuery.data?.length ?? 0})`, value: "all" },
              ...(kindsQuery.data ?? []).map((k) => ({ label: `${k.name} (${counts[k.code] ?? 0})`, value: k.code })),
            ]}
          />
          <Input.Search allowClear placeholder="Поиск по названию или коду 1С" style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
          {kind !== "all" && (
            <TreeSelect
              allowClear
              showSearch
              treeNodeFilterProp="title"
              placeholder="Группа (с подгруппами)"
              style={{ width: 260 }}
              value={group}
              onChange={(v) => setGroup(v ?? undefined)}
              treeData={[...groupTree(groups, kind), { value: NO_GROUP, title: "— без группы —", children: [] }]}
              treeDefaultExpandAll
            />
          )}
          {(kind === "all" || kind === "pf" || kind === "izdelie") && (
            <Select
              allowClear
              placeholder="Направление"
              style={{ width: 190 }}
              value={direction}
              onChange={setDirection}
              options={[...toOptions(DIRECTIONS), { value: "__none", label: "— не задано —" }]}
            />
          )}
          {kind === "pf" && (
            <Select allowClear placeholder="Стадия" style={{ width: 190 }} value={stage} onChange={setStage} options={toOptions(STAGES)} />
          )}
          <Checkbox checked={groupByProfile} onChange={(e) => setGroupByProfile(e.target.checked)}>
            Группировать профили
          </Checkbox>
          <Checkbox checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)}>
            Только с остатком
          </Checkbox>
          <Select
            allowClear
            showSearch
            placeholder="Где лежит"
            style={{ width: 200 }}
            value={place}
            onChange={setPlace}
            options={placeOptions}
            loading={stockQuery.isLoading}
          />
          <Checkbox checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
            С архивными
          </Checkbox>
          {canGroup && kind !== "all" && <Button onClick={() => setGroupsOpen(true)}>Группы…</Button>}
          {canGroup && (
            <Button type="primary" onClick={() => setQuickShieldOpen(true)}>
              + Щитовая дверь
            </Button>
          )}
          {canGroup && (
            <Button onClick={() => setWizardOpen(true)}>
              + Новая модель
            </Button>
          )}
          {canGroup && kind === "pf" && <Button onClick={() => setNewPartOpen(true)}>+ Новая деталь</Button>}
          {canGroup && kind === "pf" && <Button onClick={() => setDupOpen(true)}>Дубликаты…</Button>}
        </Space>
        {canGroup && selectedIds.length > 0 && (
          <Space wrap style={{ marginTop: 12 }}>
            <Typography.Text>Выбрано: {selectedIds.length}</Typography.Text>
            <TreeSelect
              placeholder="В группу…"
              style={{ width: 260 }}
              value={moveTo}
              onChange={setMoveTo}
              treeData={groupTree(groups, kind)}
              treeDefaultExpandAll
            />
            <Button type="primary" disabled={moveTo == null} loading={moveMutation.isPending} onClick={() => moveTo != null && moveMutation.mutate(moveTo)}>
              Перенести
            </Button>
            <Button onClick={() => moveMutation.mutate(null)}>Убрать из группы</Button>
            {(kind === "pf" || kind === "izdelie") && <Button onClick={() => setAttrsOpen(true)}>Признаки…</Button>}
            {kind === "pf" && <Button onClick={() => setBulkStagesOpen(true)}>Этапы…</Button>}
            {kind === "pf" && (
              <Space.Compact>
                <Button disabled title="Если декор ПЭТ — какой клеить на выбранные детали">
                  ПЭТ:
                </Button>
                <Button loading={petMutation.isPending} onClick={() => petMutation.mutate("2d")}>
                  2Д
                </Button>
                <Button loading={petMutation.isPending} onClick={() => petMutation.mutate("3d")}>
                  3Д
                </Button>
              </Space.Compact>
            )}
            <Button type="link" onClick={() => setSelectedIds([])}>
              Снять выбор
            </Button>
          </Space>
        )}
      </Card>
      {wizardOpen && <NewModelWizard onClose={() => setWizardOpen(false)} />}
      {quickShieldOpen && <QuickShieldDoorModal onClose={() => setQuickShieldOpen(false)} />}
      {newPartOpen && <PartParamsModal part={null} onClose={() => setNewPartOpen(false)} />}
      {dupOpen && <PartDuplicatesModal onClose={() => setDupOpen(false)} />}
      {bulkStagesOpen && (
        <BulkStagesModal
          partIds={(itemsQuery.data ?? [])
            .filter((i) => selectedIds.includes(i.id) && i.source_type === "part" && i.source_id != null)
            .map((i) => i.source_id as number)}
          onClose={(done) => {
            setBulkStagesOpen(false);
            if (done) setSelectedIds([]);
          }}
        />
      )}
      {attrsOpen && (
        <AttrsModal
          itemIds={selectedIds}
          pf={kind === "pf"}
          onClose={(done) => {
            setAttrsOpen(false);
            if (done) setSelectedIds([]);
          }}
        />
      )}
      {kind !== "all" && (
        <GroupsModal open={groupsOpen} onClose={() => setGroupsOpen(false)} kind={kind} kindName={kindName} groups={groups} />
      )}
      <ResponsiveTable<ItemRow>
        tableKey="nomenclature"
        lockedColumns={["Наименование"]}
        defaultHiddenColumns={["Код 1С", "Статус"]}
        size="small"
        rowKey="id"
        loading={itemsQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        onRow={(i) => ({
          onClick: () => {
            if (i.id > 0 && !i.is_profile_group) {
              navigate(`/item/${i.id}`);
            }
          },
          style: { cursor: i.id > 0 && !i.is_profile_group ? "pointer" : "default" },
        })}
        rowSelection={
          canGroup && kind !== "all"
            ? {
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds((keys as number[]).filter((k) => k > 0)),
                columnWidth: 40,
                getCheckboxProps: (record) => ({
                  disabled: record.id < 0 || record.is_profile_group,
                }),
              }
            : undefined
        }
        columns={[
          {
            title: "Наименование",
            render: (_, i: ItemRow) => {
              if (i.is_model) {
                return (
                  <Space size={6}>
                    <b>{i.name}</b>
                    <Tag color="gold">модель · вариантов: {i.variant_count ?? 0}</Tag>
                  </Space>
                );
              }
              if (i.is_profile_group) {
                return (
                  <Space size={6}>
                    <b>{i.name}</b>
                    <Tag color="cyan">профиль · вариантов: {i.variant_count ?? (i.children?.length ?? 0)}</Tag>
                  </Space>
                );
              }
              if (i.decor_label) {
                return (
                  <Space size={6} wrap align="center">
                    <DecorThumbnail decor={i.decor_label} size={14} />
                    <Tag color={i.decor_label === "— без плёнки —" ? "default" : "geekblue"} style={{ fontWeight: 600 }}>
                      {i.decor_label}
                    </Tag>
                    <span>{i.name}</span>
                  </Space>
                );
              }
              return i.name;
            },
          },
          { title: "Вид", render: (_, i) => <Tag color={KIND_COLOR[i.kind_code]}>{i.kind_name}</Tag> },
          ...(kind === "all" || kind === "pf" || kind === "izdelie"
            ? [
                {
                  title: "Направление",
                  render: (_: unknown, i: ItemRow) => <AttrText value={i.direction} labels={DIRECTIONS} own={i.own_attrs?.includes("direction")} />,
                },
              ]
            : []),
          ...(kind === "pf"
            ? [
                {
                  title: "Стадия",
                  render: (_: unknown, i: ItemRow) =>
                    i.stage ? (
                      <Tag color={STAGE_COLOR[i.stage]} style={i.own_attrs?.includes("stage") ? { fontWeight: 700 } : undefined}>
                        {STAGES[i.stage] ?? i.stage}
                      </Tag>
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
                {
                  title: "Режим",
                  render: (_: unknown, i: ItemRow) => <AttrText value={i.make_mode} labels={MODES} own={i.own_attrs?.includes("make_mode")} />,
                },
              ]
            : []),
          {
            title: "Группа",
            render: (_, i) => (i.group_id != null ? groupPath(groups, i.group_id) : <Typography.Text type="secondary">—</Typography.Text>),
          },
          ...(kind === "pf"
            ? [
                {
                  title: "ПЭТ",
                  render: (_: unknown, i: ItemRow) =>
                    i.is_model || i.is_profile_group ? null : i.pet_type === "3d" ? <Tag color="purple">3Д</Tag> : <Typography.Text type="secondary">2Д</Typography.Text>,
                },
              ]
            : []),
          { title: "Ед.", dataIndex: "unit" },
          {
            title: "Остаток",
            align: "right" as const,
            render: (_: unknown, i: ItemRow) => <StockQty s={stockSum(i, stockOf)} />,
          },
          {
            title: "Резерв",
            align: "right" as const,
            render: (_: unknown, i: ItemRow) => {
              const s = stockSum(i, stockOf);
              return s && s.reserved > 0 ? <Typography.Text type="warning">{fmt(s.reserved)}</Typography.Text> : null;
            },
          },
          {
            title: "Доступно",
            align: "right" as const,
            render: (_: unknown, i: ItemRow) => {
              const s = stockSum(i, stockOf);
              return s && s.qty > 0 ? <b>{fmt(s.free)}</b> : null;
            },
          },
          {
            title: "Где",
            render: (_: unknown, i: ItemRow) => {
              const s = stockSum(i, stockOf);
              return s && s.places.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.places.join(", ")}
                </Typography.Text>
              ) : null;
            },
          },
          { title: "Код 1С", render: (_, i) => i.code_1c ?? <Typography.Text type="secondary">—</Typography.Text> },
          { title: "Статус", render: (_, i) => (i.is_active ? <Tag color="green">активна</Tag> : <Tag>архив</Tag>) },
        ]}
      />
    </Space>
  );
}

export interface ItemRow extends Item {
  variant_count?: number;
  children?: ItemRow[];
  is_profile_group?: boolean;
  decor_label?: string | null;
}

export function parseBaseAndDecor(name: string): { baseName: string; decorLabel: string | null } {
  const dotIdx = name.lastIndexOf(" · ");
  if (dotIdx > 0) {
    return { baseName: name.slice(0, dotIdx).trim(), decorLabel: name.slice(dotIdx + 3).trim() };
  }
  const match = name.match(/^(.*?)\s*\(([^()]+)\)$/);
  if (match) {
    return { baseName: match[1].trim(), decorLabel: match[2].trim() };
  }
  return { baseName: name, decorLabel: null };
}

const fmt = (v: number) => v.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Остаток позиции; у модели или группы профиля — сумма по её вариантам (единица у них одна). */
function stockSum(i: ItemRow, stockOf: Map<number, ItemStock>): ItemStock | undefined {
  if (!i.is_model && !i.is_profile_group) return stockOf.get(i.id);
  const parts = (i.children && i.children.length > 0 ? i.children : [i])
    .map((x) => stockOf.get(x.id))
    .filter((x): x is ItemStock => !!x);
  if (!parts.length) return undefined;
  return parts.reduce((a, b) => ({
    ...a,
    qty: a.qty + b.qty,
    reserved: a.reserved + b.reserved,
    free: a.free + b.free,
    lots: a.lots + b.lots,
    area_m2: a.area_m2 != null || b.area_m2 != null ? (a.area_m2 ?? 0) + (b.area_m2 ?? 0) : null,
    places: [...new Set([...a.places, ...b.places])].sort(),
  }));
}

function StockQty({ s }: { s?: ItemStock }) {
  if (!s || s.qty <= 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const lots = s.lots ? ` · ${s.kind === "plenka" ? "рул./штр." : "парт."} ${s.lots}` : "";
  return (
    <span title={s.area_m2 != null ? `${fmt(s.area_m2)} м²` : undefined}>
      {fmt(s.qty)} {s.unit}
      {(s.area_m2 != null || lots) && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {s.area_m2 != null ? ` · ${fmt(s.area_m2)} м²` : ""}
          {lots}
        </Typography.Text>
      )}
    </span>
  );
}

/** Своё значение — жирным, взятое у типа / по правилу — обычным. */
function AttrText({ value, labels, own }: { value?: string | null; labels: Record<string, string>; own?: boolean }) {
  if (!value) return <Typography.Text type="secondary">—</Typography.Text>;
  return <span style={own ? { fontWeight: 700 } : undefined} title={own ? "задано у позиции" : "как у типа / по правилу"}>{labels[value] ?? value}</span>;
}

const KEEP = "__keep";
const AUTO = "auto";

/** Массово: направление, стадия, режим выбранных позиций. */
function AttrsModal({ itemIds, pf, onClose }: { itemIds: number[]; pf: boolean; onClose: (done: boolean) => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<{ direction: string; stage: string; make_mode: string }>({ direction: KEEP, stage: KEEP, make_mode: KEEP });
  const opts = (m: Record<string, string>, autoLabel: string) => [
    { value: KEEP, label: "— не менять —" },
    { value: AUTO, label: autoLabel },
    ...toOptions(m),
  ];
  const mutation = useMutation({
    mutationFn: () =>
      setItemsAttrs({
        item_ids: itemIds,
        ...(v.direction !== KEEP ? { direction: v.direction } : {}),
        ...(pf && v.stage !== KEEP ? { stage: v.stage } : {}),
        ...(pf && v.make_mode !== KEEP ? { make_mode: v.make_mode } : {}),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      message.success(`Признаки изменены: ${r.updated}`);
      onClose(true);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить признаки")),
  });
  const nothing = v.direction === KEEP && (!pf || (v.stage === KEEP && v.make_mode === KEEP));
  const row = (label: string, key: "direction" | "stage" | "make_mode", m: Record<string, string>, autoLabel: string) => (
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Text>{label}</Typography.Text>
      <Select style={{ width: 260 }} value={v[key]} onChange={(x) => setV((s) => ({ ...s, [key]: x }))} options={opts(m, autoLabel)} />
    </Space>
  );
  return (
    <Modal
      open
      title={`Признаки — выбрано ${itemIds.length}`}
      okText="Применить"
      cancelText="Отмена"
      okButtonProps={{ disabled: nothing }}
      confirmLoading={mutation.isPending}
      onOk={() => mutation.mutate()}
      onCancel={() => onClose(false)}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="middle">
        {row("Направление", "direction", DIRECTIONS, "как у типа")}
        {pf && row("Стадия", "stage", STAGES, "как у типа")}
        {pf && row("Режим", "make_mode", MODES, "по правилу")}
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Режим по правилу: щиты и панели — под заказ; деталь в плёнке — под заказ (излишки уходят в остаток); заготовки,
          детали без плёнки и после снятия — на склад.
        </Typography.Text>
      </Space>
    </Modal>
  );
}

function UnlinkedTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canLink = hasPerm(user, "production_tasks.manage");
  const [choice, setChoice] = useState<Record<string, number | undefined>>({});
  const [sizesOpen, setSizesOpen] = useState(false);
  const unlinkedQuery = useQuery({ queryKey: ["items-unlinked"], queryFn: listUnlinkedLines });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const partOptions = (partsQuery.data ?? []).filter((p) => p.is_active).map((p) => ({ value: p.id, label: p.name }));

  const mutation = useMutation({
    mutationFn: (v: { part_name: string; part_id: number }) => linkLines(v),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["items-unlinked"] });
      qc.invalidateQueries({ queryKey: ["items-manual"] });
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      message.success(`Связано: строк заданий ${res.task_lines}, строк BOM ${res.bom_lines}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось связать")),
  });

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Названия деталей в строках заданий цеха и BOM моделей, которых нет в справочнике деталей. Такие строки не
          списывают п/ф по отчёту и не попадают в потребность. Выберите деталь и нажмите «Связать» — свяжутся все строки
          с этим названием (текст строк не меняется). Общие названия в BOM вроде «Стоевая (МежКомн)» — это тип детали, а
          не конкретный размер: для них — «Создать позиции по размерам», каждый размер станет своей позицией.
        </Typography.Paragraph>
        {canLink && (
          <Button style={{ marginTop: 12 }} onClick={() => setSizesOpen(true)}>
            Создать позиции по размерам…
          </Button>
        )}
      </Card>
      {sizesOpen && <SizePartsModal onClose={() => setSizesOpen(false)} />}
      <ResponsiveTable<UnlinkedLineGroup>
        tableKey="nomenclature-unlinked"
        lockedColumns={["Название в строках"]}
        size="small"
        rowKey="part_name"
        loading={unlinkedQuery.isLoading}
        dataSource={unlinkedQuery.data ?? []}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Все строки связаны с деталями" }}
        columns={[
          { title: "Название в строках", dataIndex: "part_name" },
          {
            title: "Задания цеха",
            render: (_, g) => (g.task_lines ? `${g.task_lines}${g.active_task_lines ? ` (активных ${g.active_task_lines})` : ""}` : "—"),
          },
          { title: "BOM моделей", render: (_, g) => g.bom_lines || "—" },
          {
            title: "Деталь",
            render: (_, g) => (
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                style={{ width: 360 }}
                placeholder={g.suggestions[0] ? `Похоже: ${g.suggestions[0].part_name}` : "Выберите деталь"}
                disabled={!canLink}
                value={choice[g.part_name]}
                onChange={(v) => setChoice((prev) => ({ ...prev, [g.part_name]: v }))}
                options={[
                  ...(g.suggestions.length
                    ? [{ label: "Похожие", options: g.suggestions.map((s) => ({ value: s.part_id, label: s.part_name })) }]
                    : []),
                  { label: "Все детали", options: partOptions },
                ]}
              />
            ),
          },
          {
            title: "",
            render: (_, g) =>
              canLink && (
                <Button
                  size="small"
                  type="primary"
                  disabled={!choice[g.part_name]}
                  loading={mutation.isPending && mutation.variables?.part_name === g.part_name}
                  onClick={() => mutation.mutate({ part_name: g.part_name, part_id: choice[g.part_name] as number })}
                >
                  Связать
                </Button>
              ),
          },
        ]}
      />
    </Space>
  );
}

function ManualLinksTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canLink = hasPerm(user, "production_tasks.manage");
  const manualQuery = useQuery({ queryKey: ["items-manual"], queryFn: listManualLinks });

  const mutation = useMutation({
    mutationFn: (v: { part_name: string; part_id: number }) => unlinkLines(v),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["items-manual"] });
      qc.invalidateQueries({ queryKey: ["items-unlinked"] });
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      message.success(`Отвязано: строк заданий ${res.task_lines}, строк BOM ${res.bom_lines}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отвязать")),
  });

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Строки, связанные с деталью вручную кнопкой «Связать» (название в строке отличается от названия детали).
          Если связали не с той деталью — «Отвязать»: строки вернутся в «Строки без детали», и там можно выбрать
          правильную. Уже проведённые отчёты при этом не пересчитываются.
        </Typography.Paragraph>
      </Card>
      <ResponsiveTable<ManualLinkGroup>
        tableKey="nomenclature-manual"
        lockedColumns={["Название в строках"]}
        size="small"
        rowKey={(g) => `${g.part_name}|${g.part_id}`}
        loading={manualQuery.isLoading}
        dataSource={manualQuery.data ?? []}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Ручных связей нет" }}
        columns={[
          { title: "Название в строках", dataIndex: "part_name" },
          { title: "Связано с деталью", dataIndex: "linked_part_name" },
          { title: "Задания цеха", render: (_, g) => g.task_lines || "—" },
          { title: "BOM моделей", render: (_, g) => g.bom_lines || "—" },
          {
            title: "",
            render: (_, g) =>
              canLink && (
                <Popconfirm
                  title="Отвязать строки от детали?"
                  description="Новые отчёты по этим строкам перестанут двигать партии этой детали."
                  okText="Отвязать"
                  cancelText="Отмена"
                  onConfirm={() => mutation.mutate({ part_name: g.part_name, part_id: g.part_id })}
                >
                  <Button
                    size="small"
                    danger
                    loading={mutation.isPending && mutation.variables?.part_name === g.part_name && mutation.variables?.part_id === g.part_id}
                  >
                    Отвязать
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
    </Space>
  );
}

const sizeKey = (c: SizeCandidate) => `${c.part_name}|${c.width_mm}|${c.length_m}`;

/** Строки без детали по названию И размеру — каждая группа становится своей
 * позицией п/ф (решение 24.09: отдельная позиция на размер), строки сразу
 * связываются с ней. Маршрут — копия маршрута выбранной детали. */
function SizePartsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const candidatesQuery = useQuery({ queryKey: ["items-size-candidates"], queryFn: listSizeCandidates });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const [selected, setSelected] = useState<string[]>([]);
  const [routePartId, setRoutePartId] = useState<number | null | undefined>(undefined);

  // По умолчанию — самый частый маршрут среди активных деталей.
  const defaultRoutePartId = useMemo(() => {
    const byChain = new Map<string, { id: number; n: number }>();
    for (const p of partsQuery.data ?? []) {
      if (!p.is_active || p.stages.length === 0) continue;
      const key = p.stages.map((s) => `${s.name}@${s.area ?? ""}`).join(">");
      const cur = byChain.get(key);
      byChain.set(key, { id: cur?.id ?? p.id, n: (cur?.n ?? 0) + 1 });
    }
    return [...byChain.values()].sort((a, b) => b.n - a.n)[0]?.id ?? null;
  }, [partsQuery.data]);
  const route = routePartId === undefined ? defaultRoutePartId : routePartId;
  const routePart = (partsQuery.data ?? []).find((p) => p.id === route);

  const mutation = useMutation({
    mutationFn: () =>
      createSizeParts({
        keys: (candidatesQuery.data ?? [])
          .filter((c) => selected.includes(sizeKey(c)))
          .map((c): [string, number, number] => [c.part_name, c.width_mm, c.length_m]),
        route_part_id: route,
      }),
    onSuccess: (res) => {
      for (const key of [["items-size-candidates"], ["items-unlinked"], ["items-manual"], ["items"], ["pf-demand"], ["dict-autocomplete", "parts"]])
        qc.invalidateQueries({ queryKey: key });
      message.success(
        `Создано позиций: ${res.created}${res.linked_existing ? `, связано с уже существующими: ${res.linked_existing}` : ""}. ` +
          `Связано строк заданий ${res.task_lines}, BOM ${res.bom_lines}`,
      );
      setSelected([]);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать позиции")),
  });

  return (
    <Modal
      open
      width={980}
      title="Создать позиции по размерам"
      onCancel={onClose}
      okText={`Создать и связать (${selected.length})`}
      okButtonProps={{ disabled: selected.length === 0, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
      cancelText="Закрыть"
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Отметьте группы — каждая станет позицией п/ф с этим размером, её строки в заданиях и BOM сразу свяжутся с ней.
          Размеры и ширина штрипса берутся из строк. Новые строки с тем же названием и размером дальше будут
          связываться сами.
        </Typography.Text>
        <Space wrap>
          <Typography.Text>Маршрут как у детали:</Typography.Text>
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            style={{ width: 360 }}
            placeholder="Без маршрута"
            value={route ?? undefined}
            onChange={(v) => setRoutePartId(v ?? null)}
            options={(partsQuery.data ?? []).filter((p) => p.is_active && p.stages.length > 0).map((p) => ({ value: p.id, label: p.name }))}
          />
          {routePart && <Typography.Text type="secondary">{routePart.stages.map((s) => s.name).join(" → ")}</Typography.Text>}
        </Space>
        <ResponsiveTable<SizeCandidate>
          tableKey="nomenclature-size-candidates"
          lockedColumns={["Новая позиция"]}
          size="small"
          rowKey={sizeKey}
          loading={candidatesQuery.isLoading}
          dataSource={candidatesQuery.data ?? []}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content", y: 420 }}
          locale={{ emptyText: "Строк без детали нет" }}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
          columns={[
            {
              title: "Новая позиция",
              render: (_, c) => (
                <Space orientation="vertical" size={0}>
                  <span>{c.proposed_name}</span>
                  {c.existing_part_id && <Tag color="blue">уже есть — только связать</Tag>}
                </Space>
              ),
            },
            { title: "Название в строках", dataIndex: "part_name" },
            { title: "Ширина, мм", render: (_, c) => c.width_mm },
            { title: "Длина, м", render: (_, c) => c.length_m },
            { title: "Штрипс, мм", render: (_, c) => c.strip_width_mm ?? "—" },
            {
              title: "Строк",
              render: (_, c) =>
                [
                  c.task_lines ? `заданий ${c.task_lines}${c.active_task_lines ? ` (акт. ${c.active_task_lines})` : ""}` : "",
                  c.bom_lines ? `BOM ${c.bom_lines}` : "",
                ]
                  .filter(Boolean)
                  .join(", "),
            },
          ]}
        />
      </Space>
    </Modal>
  );
}

