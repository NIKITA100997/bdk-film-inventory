import { useMemo, useState } from "react";
import DictionaryAdmin from "./DictionaryAdmin";
import { DIRECTIONS, MODES, STAGES, STAGE_COLOR, toOptions } from "../../utils/itemAttrs";
import { isAxiosError } from "axios";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, Checkbox, Input, Modal, Popconfirm, Segmented, Select, Space, Tabs, Tag, TreeSelect, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import TypesTab from "./nomenclature/TypesTab";
import GroupsModal from "./nomenclature/GroupsModal";
import NewModelWizard from "./nomenclature/NewModelWizard";
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

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange", izdelie: "green", material: "cyan" };

/** Номенклатура — одна запись на любую позицию (плёнка, п/ф, изделие…),
 * вид задаёт, в чём она учитывается; здесь же типы с правилами и прежние
 * справочники деталей и моделей (единая модель, 24.09). Вкладка — в адресе
 * (?tab=…): на неё ведут пункты меню и старые адреса /parts, /product-models. */
export default function Nomenclature() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const canConfigure = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const canDicts = !!user?.is_superuser || !!user?.permissions.includes("materials.manage");
  const tabs = [
    { key: "items", label: "Номенклатура", children: <ItemsTab /> },
    { key: "types", label: "Типы и правила", children: <TypesTab /> },
    ...(canConfigure
      ? [
          { key: "models", label: "Модели продукции (BOM)", children: <ProductModels /> },
        ]
      : []),
    { key: "unlinked", label: "Строки без детали", children: <UnlinkedTab /> },
    { key: "manual", label: "Связанные вручную", children: <ManualLinksTab /> },
    // Справочники (материалы, цвета, толщины, причины брака…) — вкладкой, не пунктом меню (30.09).
    ...(canDicts ? [{ key: "dicts", label: "Справочники", children: <DictionaryAdmin /> }] : []),
  ];
  const active = tabs.some((t) => t.key === params.get("tab")) ? (params.get("tab") as string) : "items";
  return <Tabs activeKey={active} onChange={(k) => setParams(k === "items" ? {} : { tab: k })} items={tabs} destroyOnHidden />;
}

const NO_GROUP = -1;

function ItemsTab() {
  const { user } = useAuth();
  const canGroup = !!user?.is_superuser || !!user?.permissions.some((c) => c === "production_tasks.manage" || c === "materials.manage");
  const qc = useQueryClient();
  // ?kind=pf — старый адрес /parts (бывшая вкладка «Детали п/ф») ведёт сюда.
  const [urlParams] = useSearchParams();
  const [kind, setKind] = useState<string>(urlParams.get("kind") ?? "all");
  const [newPartOpen, setNewPartOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [bulkStagesOpen, setBulkStagesOpen] = useState(false);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [group, setGroup] = useState<number | undefined>();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [moveTo, setMoveTo] = useState<number | undefined>();
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [direction, setDirection] = useState<string | undefined>();
  const [stage, setStage] = useState<string | undefined>();
  const [attrsOpen, setAttrsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const kindsQuery = useQuery({ queryKey: ["item-kinds"], queryFn: listItemKinds });
  const groupsQuery = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const itemsQuery = useQuery({
    queryKey: ["items", includeInactive],
    queryFn: () => listItems({ include_inactive: includeInactive }),
  });

  // Модели — строками, их варианты — внутри (как характеристики в 1С).
  // Поиск: подошла модель — все её варианты; подошёл вариант — модель с ним.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/ё/g, "е");
    const inGroup = group != null && group !== NO_GROUP ? groupWithDescendants(groups, group) : null;
    const all = itemsQuery.data ?? [];
    const matches = (i: Item) =>
      !needle || i.name.toLowerCase().replace(/ё/g, "е").includes(needle) || (i.code_1c ?? "").toLowerCase().includes(needle);
    const models = new Set(all.filter((i) => i.is_model).map((i) => i.id));
    const variants = new Map<number, Item[]>();
    for (const i of all) if (i.model_id != null && models.has(i.model_id)) variants.set(i.model_id, [...(variants.get(i.model_id) ?? []), i]);
    const out: ItemRow[] = [];
    const inSelectedGroup = (x: Item) =>
      group == null || (group === NO_GROUP ? x.group_id == null : x.group_id != null && inGroup!.has(x.group_id));
    for (const i of all) {
      if (i.model_id != null && models.has(i.model_id)) continue;
      if (kind !== "all" && i.kind_code !== kind) continue;
      if (direction && (direction === "__none" ? i.direction : i.direction !== direction)) continue;
      if (stage && i.stage !== stage) continue;
      // Модель в группе, если в ней она сама или хоть один её вариант —
      // у модели своей группы обычно нет, группы ведутся по вариантам.
      if (!inSelectedGroup(i) && !(i.is_model && (variants.get(i.id) ?? []).some(inSelectedGroup))) continue;
      if (i.is_model) {
        const own = variants.get(i.id) ?? [];
        const kids = matches(i) ? own : own.filter(matches);
        if (!matches(i) && kids.length === 0) continue;
        out.push({ ...i, variant_count: own.length, children: kids.length ? kids : undefined });
      } else if (matches(i)) {
        out.push(i);
      }
    }
    return out;
  }, [itemsQuery.data, kind, q, group, groups, direction, stage]);

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
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
          <Checkbox checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
            С архивными
          </Checkbox>
          {canGroup && kind !== "all" && <Button onClick={() => setGroupsOpen(true)}>Группы…</Button>}
          {canGroup && (
            <Button type="primary" onClick={() => setWizardOpen(true)}>
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
        size="small"
        rowKey="id"
        loading={itemsQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        onRow={(i) => ({ onClick: () => navigate(`/item/${i.id}`), style: { cursor: "pointer" } })}
        rowSelection={
          canGroup && kind !== "all"
            ? { selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys as number[]), columnWidth: 40 }
            : undefined
        }
        columns={[
          {
            title: "Наименование",
            render: (_, i: ItemRow) =>
              i.is_model ? (
                <Space size={6}>
                  <b>{i.name}</b>
                  <Tag color="gold">модель · вариантов: {i.variant_count ?? 0}</Tag>
                </Space>
              ) : (
                i.name
              ),
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
                    i.is_model ? null : i.pet_type === "3d" ? <Tag color="purple">3Д</Tag> : <Typography.Text type="secondary">2Д</Typography.Text>,
                },
              ]
            : []),
          { title: "Ед.", dataIndex: "unit" },
          { title: "Код 1С", render: (_, i) => i.code_1c ?? <Typography.Text type="secondary">—</Typography.Text> },
          { title: "Статус", render: (_, i) => (i.is_active ? <Tag color="green">активна</Tag> : <Tag>архив</Tag>) },
        ]}
      />
    </Space>
  );
}

type ItemRow = Item & { variant_count?: number; children?: Item[] };

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
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
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
  const canLink = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
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
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
  const canLink = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
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
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
                <Space direction="vertical" size={0}>
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

