import { useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, Input, Segmented, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";
import { listParts } from "../../api/dictionaries";
import {
  linkLines,
  listItemKinds,
  listItems,
  listUnlinkedLines,
  type Item,
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
      ]}
    />
  );
}

function ItemsTab() {
  const navigate = useNavigate();
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

  const open = (i: Item) => {
    if (i.source_type === "sku") navigate("/materials", { state: { material: i.material, color: i.color, thickness: i.thickness } });
    else if (i.source_type === "part") navigate("/part-card", { state: { partId: i.source_id } });
    else if (i.source_type === "model") navigate("/product-models");
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card>
        <Typography.Paragraph type="secondary">
          Все позиции в одном списке: плёнка, п/ф, изделия. Вид задаёт, в чём позиция учитывается. Правка — пока в
          привычных справочниках (клик по строке открывает карточку). Код 1С заполним при сопоставлении с 1С.
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
        onRow={(i) => ({ onClick: () => open(i), style: { cursor: i.source_type ? "pointer" : undefined } })}
        columns={[
          { title: "Наименование", dataIndex: "name" },
          { title: "Вид", render: (_, i) => <Tag color={KIND_COLOR[i.kind_code]}>{i.kind_name}</Tag> },
          { title: "Ед.", dataIndex: "unit" },
          { title: "Код 1С", render: (_, i) => i.code_1c ?? <Typography.Text type="secondary">—</Typography.Text> },
          { title: "Статус", render: (_, i) => (i.is_active ? <Tag color="green">активна</Tag> : <Tag>архив</Tag>) },
        ]}
      />
    </Space>
  );
}

function UnlinkedTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canLink = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [choice, setChoice] = useState<Record<string, number | undefined>>({});
  const unlinkedQuery = useQuery({ queryKey: ["items-unlinked"], queryFn: listUnlinkedLines });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const partOptions = (partsQuery.data ?? []).filter((p) => p.is_active).map((p) => ({ value: p.id, label: p.name }));

  const mutation = useMutation({
    mutationFn: (v: { part_name: string; part_id: number }) => linkLines(v),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["items-unlinked"] });
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
          не конкретный размер: их правильно решать техкартами на следующем этапе, связывать с одной деталью не нужно.
        </Typography.Paragraph>
      </Card>
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
