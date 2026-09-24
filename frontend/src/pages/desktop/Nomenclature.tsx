import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, Drawer, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tabs, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import TypesTab from "./nomenclature/TypesTab";
import ItemPropertiesSection from "./nomenclature/ItemPropertiesSection";
import { useAuth } from "../../auth/AuthContext";
import { listParts } from "../../api/dictionaries";
import {
  createSizeParts,
  getTechCard,
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

const KIND_COLOR: Record<string, string> = { plenka: "blue", pf: "orange", izdelie: "green" };

/** Номенклатура — одна запись на любую позицию (плёнка, п/ф, изделие…),
 * вид задаёт, в чём она учитывается. Первый этап перехода на единую модель:
 * позиции по-прежнему правятся в своих справочниках, здесь — общий список и
 * переход в привычную карточку. */
export default function Nomenclature() {
  return (
    <Tabs
      items={[
        { key: "items", label: "Номенклатура", children: <ItemsTab /> },
        { key: "unlinked", label: "Строки без детали", children: <UnlinkedTab /> },
        { key: "manual", label: "Связанные вручную", children: <ManualLinksTab /> },
        { key: "types", label: "Типы и свойства", children: <TypesTab /> },
      ]}
    />
  );
}

function ItemsTab() {
  const [kind, setKind] = useState<string>("all");
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const kindsQuery = useQuery({ queryKey: ["item-kinds"], queryFn: listItemKinds });
  const itemsQuery = useQuery({
    queryKey: ["items", includeInactive],
    queryFn: () => listItems({ include_inactive: includeInactive }),
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/ё/g, "е");
    return (itemsQuery.data ?? []).filter(
      (i) =>
        (kind === "all" || i.kind_code === kind) &&
        (!needle || i.name.toLowerCase().replace(/ё/g, "е").includes(needle) || (i.code_1c ?? "").toLowerCase().includes(needle)),
    );
  }, [itemsQuery.data, kind, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of itemsQuery.data ?? []) c[i.kind_code] = (c[i.kind_code] ?? 0) + 1;
    return c;
  }, [itemsQuery.data]);

  const [card, setCard] = useState<Item | null>(null);

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Typography.Paragraph type="secondary">
          Все позиции в одном списке: плёнка, п/ф, изделия. Вид задаёт, в чём позиция учитывается. Клик по строке —
          техкарта: маршрут, состав и где используется. Правка — пока в привычных справочниках. Код 1С заполним при сопоставлении с 1С.
        </Typography.Paragraph>
        <Space wrap size={[12, 12]}>
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as string)}
            options={[
              { label: `Все (${itemsQuery.data?.length ?? 0})`, value: "all" },
              ...(kindsQuery.data ?? []).map((k) => ({ label: `${k.name} (${counts[k.code] ?? 0})`, value: k.code })),
            ]}
          />
          <Input.Search allowClear placeholder="Поиск по названию или коду 1С" style={{ width: 320 }} value={q} onChange={(e) => setQ(e.target.value)} />
          <Checkbox checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)}>
            С архивными
          </Checkbox>
        </Space>
      </Card>
      <ResponsiveTable<Item>
        tableKey="nomenclature"
        lockedColumns={["Наименование"]}
        size="small"
        rowKey="id"
        loading={itemsQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        onRow={(i) => ({ onClick: () => setCard(i), style: { cursor: "pointer" } })}
        columns={[
          { title: "Наименование", dataIndex: "name" },
          { title: "Вид", render: (_, i) => <Tag color={KIND_COLOR[i.kind_code]}>{i.kind_name}</Tag> },
          { title: "Ед.", dataIndex: "unit" },
          { title: "Код 1С", render: (_, i) => i.code_1c ?? <Typography.Text type="secondary">—</Typography.Text> },
          { title: "Статус", render: (_, i) => (i.is_active ? <Tag color="green">активна</Tag> : <Tag>архив</Tag>) },
        ]}
      />
      <TechCardDrawer item={card} onClose={() => setCard(null)} />
    </Space>
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

/** Техкарта позиции — одна карточка на любой вид: маршрут по участкам,
 * спецификация (из чего состоит) и где используется. Правка пока в
 * привычных справочниках — кнопки ведут туда. */
function TechCardDrawer({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEditTypes =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("materials.manage");
  const cardQuery = useQuery({
    queryKey: ["techcard", item?.id],
    queryFn: () => getTechCard(item!.id),
    enabled: !!item,
  });
  const card = cardQuery.data;
  const openSource = () => {
    if (!item) return;
    if (item.source_type === "sku") navigate("/materials", { state: { material: item.material, color: item.color, thickness: item.thickness } });
    else if (item.source_type === "part") navigate("/part-card", { state: { partId: item.source_id } });
    else if (item.source_type === "model") navigate("/product-models");
  };
  const qty = (v: number | null, unit: string) => (v == null ? "—" : `${Number(v.toFixed(3))} ${unit}`);

  return (
    <Drawer
      open={!!item}
      onClose={onClose}
      width={640}
      title={
        <Space direction="vertical" size={0}>
          <span>{item?.name}</span>
          {item && <Tag color={KIND_COLOR[item.kind_code]}>{item.kind_name}</Tag>}
        </Space>
      }
      extra={
        item?.source_type && (
          <Space>
            {item.source_type === "part" && <Button onClick={() => navigate("/parts")}>Изменить маршрут</Button>}
            <Button type="primary" onClick={openSource}>
              Открыть карточку
            </Button>
          </Space>
        )
      }
    >
      {cardQuery.isLoading || !card ? (
        <Typography.Text type="secondary">Загрузка…</Typography.Text>
      ) : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <section>
            <Typography.Title level={5}>Тип и свойства</Typography.Title>
            <ItemPropertiesSection itemId={card.item_id} kindCode={card.kind_code} canEdit={canEditTypes} />
          </section>
          {card.source_type !== "sku" && (
            <section>
              <Typography.Title level={5}>Маршрут</Typography.Title>
              {card.operations.length === 0 ? (
                <Typography.Text type="secondary">
                  {card.source_type === "model" ? "Маршрут изделия появится вместе с заданиями по изделиям." : "Этапы не заданы."}
                </Typography.Text>
              ) : (
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  {card.operations.map((o) => (
                    <li key={o.sequence_order}>
                      {o.name}
                      {o.area_name && o.area_name !== o.name && <Typography.Text type="secondary"> — {o.area_name}</Typography.Text>}
                      {!o.area && <Tag color="warning" style={{ marginLeft: 8 }}>участок не задан</Tag>}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {card.source_type !== "sku" && (
            <section>
              <Typography.Title level={5}>Состав на 1 шт</Typography.Title>
              {card.inputs.length === 0 ? (
                <Typography.Text type="secondary">Состав не задан.</Typography.Text>
              ) : (
                <Table
                  size="small"
                  rowKey={(_, i) => String(i)}
                  pagination={false}
                  dataSource={card.inputs}
                  columns={[
                    {
                      title: "Что",
                      render: (_, r) => (
                        <Space size={4} wrap>
                          <span>{r.name}</span>
                          {card.source_type === "model" && !r.part_id && <Tag color="warning">без позиции</Tag>}
                        </Space>
                      ),
                    },
                    { title: "Кол-во", render: (_, r) => qty(r.qty_per_unit, r.unit) },
                    { title: "", render: (_, r) => <Typography.Text type="secondary">{r.note}</Typography.Text> },
                  ]}
                />
              )}
            </section>
          )}
          <section>
            <Typography.Title level={5}>Где используется</Typography.Title>
            {card.used_in.length === 0 ? (
              <Typography.Text type="secondary">Нигде в составах не указана.</Typography.Text>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {card.used_in.map((u) => (
                  <li key={`${u.source_type}${u.source_id}`}>
                    {u.name}
                    <Typography.Text type="secondary"> — {qty(u.qty_per_unit, card.source_type === "sku" ? "м на шт" : "шт")}</Typography.Text>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Space>
      )}
    </Drawer>
  );
}
