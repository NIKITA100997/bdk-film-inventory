import { useEffect, useMemo, useState } from "react";
import NextStep from "../../components/NextStep";
import { UiBadge } from "../../components/UiBadge";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Popover,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  TreeSelect,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { listItemGroups, listItems, type ItemGroup } from "../../api/items";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import {
  COUNT_KIND_LABEL,
  addPartCountExtra,
  cancelPartCount,
  closePartCount,
  getPartCount,
  listAreaParts,
  listCountPlaces,
  listPartCounts,
  removePartCountExtra,
  resolvePartCountLine,
  resolvePartCountLines,
  setPartCountLine,
  setPartGroupCount,
  startPartCount,
  type CountDecision,
  type CountKind,
  type CountPlace,
  type PartCountDetail,
  type PartCountLine,
  type PartCountSession,
} from "../../api/partCounts";
import { STAGES } from "../../utils/itemAttrs";
import { apiErrorMessage } from "../../utils/apiError";
import { parseLotNo, pfNo, rollNo } from "../../utils/lotNo";

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 1000) / 1000}`.replace(".", ","));
const KIND_COLOR: Record<CountKind, string> = { plenka: "blue", pf: "orange", material: "cyan", fg: "green" };
const KIND_ORDER: CountKind[] = ["plenka", "pf", "material", "fg"];
const SECTION_TITLE: Record<CountKind, string> = {
  plenka: "Плёнка — рулоны и штрипсы",
  pf: "Полуфабрикаты (П/ф) — по деталям",
  material: "Материалы",
  fg: "Готовые изделия",
};
const lotLabel = (l: PartCountLine) =>
  l.kind === "plenka" ? rollNo(l.material_unit_id) : l.kind === "pf" ? (l.part_unit_id ? pfNo(l.part_unit_id) : null) : null;
const reasonCategory = (k: CountKind) => (k === "plenka" ? "warehouse" : "parts");

const DiffTag = ({ diff, unit }: { diff: number | null; unit?: string }) =>
  diff == null ? (
    <UiBadge>не считали</UiBadge>
  ) : diff === 0 ? (
    <UiBadge color="green">сошлось</UiBadge>
  ) : diff < 0 ? (
    <UiBadge color="red">
      недостача {fmt(-diff)} {unit}
    </UiBadge>
  ) : (
    <UiBadge color="orange">
      излишек {fmt(diff)} {unit}
    </UiBadge>
  );

/** Инвентаризация — одна на все виды, по месту (27.10): выбираете место
 * (участок, склад плёнки, склад материалов, склад ГП площадки), лист — всё,
 * что там по учёту, любого вида; факт — по строке (у плёнки — по бирке),
 * расхождения после закрытия решаются по строке или все сразу. */
export default function StockCounts() {
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get("count")) || null;
  const open = (id: number | null) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (id) p.set("count", String(id));
        else p.delete("count");
        return p;
      },
      { replace: false },
    );
  return openId ? <CountView id={openId} onBack={() => open(null)} /> : <CountList onOpen={open} />;
}

function CountList({ onOpen }: { onOpen: (id: number) => void }) {
  const [params] = useSearchParams();
  const presetPlaceType = params.get("place_type") || undefined;
  const wantNew = params.get("new") === "1" || !!presetPlaceType;
  const [newOpen, setNewOpen] = useState(wantNew);
  const q = useQuery({ queryKey: ["part-counts"], queryFn: listPartCounts });
  return (
    <Card
      title="Инвентаризация"
      extra={
        <Button type="primary" onClick={() => setNewOpen(true)}>
          Новая инвентаризация
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        Выберите место — склад плёнки, участок, склад материалов или склад готовой продукции. В лист попадёт всё, что там
        числится: рулоны и штрипсы, партии п/ф, материалы, изделия. Вводите факт (рулон можно отметить по номеру бирки), потом
        закройте пересчёт и решите по расхождениям: списать недостачу, оприходовать излишек или оставить как есть.
      </Typography.Paragraph>
      <ResponsiveTable<PartCountSession>
        tableKey="stock-counts-sessions"
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data ?? []}
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
        onRow={(s) => ({ onClick: () => onOpen(s.id), style: { cursor: "pointer" } })}
        locale={{ emptyText: "Инвентаризаций ещё не было" }}
        columns={[
          { title: "№", dataIndex: "id", width: 60 },
          { title: "Место", dataIndex: "place_name" },
          {
            title: "Что считали",
            render: (_, s) => (
              <Space size={4} wrap>
                {s.kinds.map((k: CountKind) => (
                  <UiBadge key={k} color={KIND_COLOR[k]}>
                    {COUNT_KIND_LABEL[k]}
                  </UiBadge>
                ))}
              </Space>
            ),
          },
          { title: "Начата", render: (_, s) => dayjs(s.started_at).format("DD.MM.YYYY HH:mm") },
          {
            title: "Статус",
            render: (_, s) =>
              s.status === "in_progress" ? (
                <UiBadge color="blue">
                  идёт · посчитано {s.lines_counted} из {s.lines_total}
                </UiBadge>
              ) : s.lines_open > 0 ? (
                <UiBadge color="orange">закрыта · без решения {s.lines_open}</UiBadge>
              ) : (
                <UiBadge color="green">закрыта</UiBadge>
              ),
          },
          { title: "Расхождений", dataIndex: "lines_diff", align: "right" },
          { title: "Заметка", render: (_, s) => s.note ?? "" },
        ]}
      />
      {newOpen && (
        <NewCountModal
          presetPlaceType={presetPlaceType}
          onClose={() => setNewOpen(false)}
          onStarted={(id) => onOpen(id)}
        />
      )}
    </Card>
  );
}

interface GroupNode {
  value: number;
  title: string;
  children: GroupNode[];
}

/** Дерево групп п/ф для охвата пересчёта участка. */
function groupTree(groups: ItemGroup[]): GroupNode[] {
  const pf = groups.filter((g) => g.kind_code === "pf");
  const build = (parent: number | null): GroupNode[] =>
    pf
      .filter((g) => g.parent_id === parent)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"))
      .map((g) => ({ value: g.id, title: g.name, children: build(g.id) }));
  return build(null);
}

const placeKey = (p: CountPlace) => `${p.place_type}|${p.place_ref ?? ""}`;

function NewCountModal({
  presetPlaceType,
  onClose,
  onStarted,
}: {
  presetPlaceType?: string;
  onClose: () => void;
  onStarted: (id: number) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ place: string; kind_mode?: string; group_ids: number[]; stages: string[]; note?: string }>();
  const placesQuery = useQuery({ queryKey: ["count-places"], queryFn: listCountPlaces });
  const groupsQuery = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const tree = useMemo(() => groupTree(groupsQuery.data ?? []), [groupsQuery.data]);
  const places = placesQuery.data ?? [];
  const placeVal = Form.useWatch("place", form);
  const place = places.find((p) => placeKey(p) === placeVal);
  const kindMode = Form.useWatch("kind_mode", form) ?? "all";
  const grouped = useMemo(() => {
    const m = new Map<string, CountPlace[]>();
    for (const p of places) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()].map(([label, ps]) => ({ label, options: ps.map((p) => ({ value: placeKey(p), label: p.name })) }));
  }, [places]);
  const myArea = user?.area ? places.find((p) => p.place_type === "area" && p.place_ref === user.area) : undefined;
  const presetPlace = presetPlaceType ? places.find((p) => p.place_type === presetPlaceType) : undefined;
  const defaultPlace = (presetPlaceType === "area" && myArea) || !presetPlaceType ? (myArea ?? presetPlace) : (presetPlace ?? myArea);

  useEffect(() => {
    if (defaultPlace && !form.getFieldValue("place")) {
      form.setFieldValue("place", placeKey(defaultPlace));
    }
  }, [defaultPlace, form]);
  const start = useMutation({
    mutationFn: (v: { place: string; kind_mode?: string; group_ids?: number[]; stages?: string[]; note?: string }) => {
      const p = places.find((x) => placeKey(x) === v.place)!;
      const kinds = v.kind_mode && v.kind_mode !== "all" ? [v.kind_mode as CountKind] : undefined;
      return startPartCount({
        place_type: p.place_type,
        place_ref: p.place_ref,
        kinds,
        scope: { group_ids: v.group_ids ?? [], stages: v.stages ?? [] },
        note: v.note || null,
      });
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["part-counts"] });
      if (d.lines_total === 0) message.warning("По учёту здесь ничего нет — можно вносить найденное сверх листа");
      onStarted(d.id);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось начать инвентаризацию")),
  });
  return (
    <Modal
      open
      title="Новая инвентаризация"
      okText="Начать"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() => form.submit()}
      okButtonProps={{ loading: start.isPending }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ place: defaultPlace ? placeKey(defaultPlace) : undefined, kind_mode: "all", group_ids: [], stages: [] }}
        onFinish={(v) => start.mutate(v)}
      >
        <Form.Item
          name="place"
          label="Место"
          rules={[{ required: true, message: "Выберите место" }]}
          extra={
            place ? (
              <span>
                Считаем:{" "}
                {place.kinds.map((k) => (
                  <UiBadge key={k} color={KIND_COLOR[k]}>
                    {COUNT_KIND_LABEL[k]}
                  </UiBadge>
                ))}
              </span>
            ) : undefined
          }
        >
          <Select showSearch optionFilterProp="label" placeholder="Где считаем" loading={placesQuery.isLoading} options={grouped} />
        </Form.Item>
        {place && place.kinds.length > 1 && (
          <Form.Item name="kind_mode" label="Что считаем" initialValue="all">
            <Radio.Group buttonStyle="solid">
              <Radio.Button value="all">Всё ({place.kinds.map((k) => COUNT_KIND_LABEL[k]).join(", ")})</Radio.Button>
              {place.kinds.map((k) => (
                <Radio.Button key={k} value={k}>
                  Только {COUNT_KIND_LABEL[k]}
                </Radio.Button>
              ))}
            </Radio.Group>
          </Form.Item>
        )}
        {place?.place_type === "area" && place.kinds.includes("pf") && kindMode !== "plenka" && (
          <>
            <Form.Item name="group_ids" label="Какие п/ф" extra="Пусто — все п/ф участка. Группа включает свои подгруппы.">
              <TreeSelect
                treeData={tree}
                treeCheckable
                showCheckedStrategy={TreeSelect.SHOW_PARENT}
                placeholder="Все группы"
                allowClear
                treeDefaultExpandAll
                loading={groupsQuery.isLoading}
              />
            </Form.Item>
            <Form.Item name="stages" label="Стадия п/ф" extra="Пусто — все стадии.">
              <Checkbox.Group options={Object.entries(STAGES).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
          </>
        )}
        <Form.Item name="note" label="Заметка">
          <Input placeholder="например, конец месяца" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CountView({ id, onBack }: { id: number; onBack: () => void }) {
  const q = useQuery({ queryKey: ["part-count", id], queryFn: () => getPartCount(id) });
  if (q.isLoading) return <Spin style={{ display: "block", margin: 48 }} />;
  if (!q.data) return <Empty description="Инвентаризация не найдена" />;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" style={{ padding: 0 }} onClick={onBack}>
        ← Все инвентаризации
      </Button>
      {q.data.status === "in_progress" ? <CountSheet d={q.data} onBack={onBack} /> : <CountResult d={q.data} />}
    </Space>
  );
}

function matches(l: PartCountLine, f: string) {
  if (!f) return true;
  return [l.name, l.group_name, l.detail, l.dimensions, l.stage_name, lotLabel(l), l.location_code].some((x) =>
    (x ?? "").toLowerCase().includes(f)
  );
}

function CountSheet({ d, onBack }: { d: PartCountDetail; onBack: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [scan, setScan] = useState("");
  const [selectedKind, setSelectedKind] = useState<"all" | CountKind>("all");
  const put = (data: PartCountDetail) => {
    qc.setQueryData(["part-count", d.id], data);
    qc.invalidateQueries({ queryKey: ["part-counts"] });
  };
  const setCount = useMutation({
    mutationFn: ({ lineId, v }: { lineId: number; v: number | null }) => setPartCountLine(d.id, lineId, v),
    onSuccess: put,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить факт")),
  });
  const setGroupCount = useMutation({
    mutationFn: ({ partId, stageId, v }: { partId: number; stageId?: number | null; v: number | null }) =>
      setPartGroupCount(d.id, { part_id: partId, stage_id: stageId, counted_qty: v }),
    onSuccess: put,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить факт по детали")),
  });
  const allMatch = useMutation({
    mutationFn: async (lines: PartCountLine[]) => {
      let last: PartCountDetail | null = null;
      for (const ln of lines) last = await setPartCountLine(d.id, ln.id, ln.expected_qty);
      return last!;
    },
    onSuccess: put,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const found = useMutation({
    mutationFn: (unitId: number) => addPartCountExtra(d.id, { kind: "plenka", material_unit_id: unitId }),
    onSuccess: (data, unitId) => {
      put(data);
      const ln = data.lines.find((l) => l.material_unit_id === unitId);
      message.success(ln?.elsewhere ? `${rollNo(unitId)} — по учёту не здесь (${ln.elsewhere}), добавлен как найденный` : `${rollNo(unitId)} — есть`);
      setScan("");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отметить рулон")),
  });
  const removeExtra = useMutation({ mutationFn: (lineId: number) => removePartCountExtra(d.id, lineId), onSuccess: put });
  const close = useMutation({
    mutationFn: () => closePartCount(d.id),
    onSuccess: (data) => {
      put(data);
      message.success(data.lines_diff ? `Пересчёт закрыт — расхождений ${data.lines_diff}, решите по каждому` : "Пересчёт закрыт — всё сошлось");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось закрыть")),
  });
  const cancel = useMutation({
    mutationFn: () => cancelPartCount(d.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-counts"] });
      onBack();
    },
  });
  const left = d.lines_total - d.lines_counted;
  const f = filter.trim().toLowerCase();
  const visible = d.lines.filter((l) => matches(l, f) && (!onlyOpen || l.counted_qty == null));
  const activeKindsOrder: CountKind[] = d.place_type === "area" ? ["pf", "plenka", "material", "fg"] : ["plenka", "pf", "material", "fg"];
  const kinds = activeKindsOrder.filter((k) => d.kinds.includes(k) || visible.some((l) => l.kind === k));
  const displayedKinds = kinds.filter((k) => selectedKind === "all" || selectedKind === k);

  const onScan = () => {
    const raw = scan.trim();
    if (!raw) return;
    const lot = parseLotNo(raw);
    if (lot?.kind === "pf") {
      const ln = d.lines.find((l) => l.part_unit_id === lot.id);
      if (!ln) return message.warning(`${pfNo(lot.id)} нет в листе — добавьте через «Найдено сверх листа»`);
      setCount.mutate({ lineId: ln.id, v: ln.expected_qty });
      setScan("");
      return;
    }
    const filmId = lot?.kind === "plenka" ? lot.id : /^\d+$/.test(raw) ? Number(raw) : null;
    if (filmId == null) return message.warning("Не похоже на номер бирки: введите ПЛ-1015, ПФ-193 или число с бирки рулона");
    if (!d.kinds.includes("plenka") && !d.lines.some((l) => l.kind === "plenka")) return message.warning("В этом месте плёнку не считаем");
    found.mutate(filmId);
  };

  const qtyInput = (l: PartCountLine) => (
    <InputNumber
      min={0}
      precision={l.kind === "pf" || l.kind === "fg" ? 0 : undefined}
      inputMode="decimal"
      style={{ width: 110 }}
      defaultValue={l.counted_qty ?? undefined}
      key={`${l.id}-${l.counted_qty}`}
      placeholder={fmt(l.expected_qty)}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const v = raw === "" ? null : Number(raw.replace(",", "."));
        if (v !== l.counted_qty && (v == null || !Number.isNaN(v))) setCount.mutate({ lineId: l.id, v });
      }}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
  const extraCol = {
    title: "",
    render: (_: unknown, l: PartCountLine) =>
      l.expected_qty === 0 && !l.part_unit_id ? (
        <Button size="small" type="link" danger onClick={() => removeExtra.mutate(l.id)}>
          убрать
        </Button>
      ) : null,
  };

  return (
    <Card title={`Инвентаризация №${d.id} · ${d.place_name}`} extra={<UiBadge color="blue">идёт</UiBadge>}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {left > 0 ? (
          <NextStep
            tone="action"
            title={`Посчитайте: осталось ${left} из ${d.lines_total}`}
            text={
              d.kinds.includes("plenka") && d.kinds.includes("pf")
                ? "Плёнка пересчитывается по биркам рулонов (сканером или по номеру); полуфабрикаты (П/ф) — визуально по деталям с единым вводом фактического количества на деталь."
                : d.kinds.includes("plenka")
                ? "Сканируйте бирки (или вводите номер) — «Есть»; количество — в строке. Найденное не по листу — «Найдено сверх листа»."
                : d.kinds.includes("pf")
                ? "Полуфабрикаты без этикеток: считайте фактическое количество штук на стеллаже по наименованию детали. «Есть» подтверждает учётное количество; кнопка «Остальное сходится» — для всего раздела."
                : "Введите, сколько есть на самом деле, в каждой строке. Сошлось — «Остальное сходится»."
            }
          />
        ) : (
          <NextStep
            tone="action"
            title="Всё посчитано — закройте пересчёт"
            text="После закрытия по каждому расхождению решите: списать, оприходовать или оставить."
            actionLabel="Закрыть пересчёт"
            onAction={() => close.mutate()}
            loading={close.isPending}
          />
        )}
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap size={10}>
            {kinds.length > 1 && (
              <Segmented
                value={selectedKind}
                onChange={(val) => setSelectedKind(val as "all" | CountKind)}
                options={[
                  { label: `Все виды (${visible.length})`, value: "all" },
                  ...kinds.map((k) => ({
                    label: `${COUNT_KIND_LABEL[k]} (${visible.filter((l) => l.kind === k).length})`,
                    value: k,
                  })),
                ]}
              />
            )}
            {displayedKinds.includes("plenka") && (
              <Input.Search
                placeholder="Бирка рулона: ПЛ-1015 или число"
                enterButton="Есть"
                style={{ width: 280 }}
                value={scan}
                loading={found.isPending}
                onChange={(e) => setScan(e.target.value)}
                onSearch={onScan}
              />
            )}
            <Input.Search
              allowClear
              placeholder="Поиск в листе (деталь, размеры...)"
              style={{ width: 240 }}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Checkbox checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)}>
              только не посчитанные
            </Checkbox>
          </Space>
          <Space wrap>
            <Progress type="line" percent={d.lines_total ? Math.round((d.lines_counted / d.lines_total) * 100) : 100} style={{ width: 160 }} size="small" />
            <Typography.Text type="secondary">
              посчитано {d.lines_counted} из {d.lines_total}
            </Typography.Text>
          </Space>
        </Space>

        {d.lines.length === 0 && <Empty description="По учёту здесь ничего нет — внесите найденное сверх листа" />}
        {displayedKinds.map((k) => {
          const rows = visible.filter((l) => l.kind === k);
          if (!rows.length && !d.lines.some((l) => l.kind === k)) return null;
          const open = rows.filter((l) => l.counted_qty == null && l.expected_qty > 0);
          return (
            <Card
              key={k}
              size="small"
              title={
                <Space size={8}>
                  <UiBadge color={KIND_COLOR[k]}>{COUNT_KIND_LABEL[k]}</UiBadge>
                  <span>{SECTION_TITLE[k]}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {k === "pf" ? `позиций ${new Set(rows.map((r) => `${r.part_id}|${r.stage_id}`)).size} (партий ${rows.length})` : `строк ${rows.length}`}
                  </Typography.Text>
                </Space>
              }
              extra={
                open.length > 0 && (
                  <Popconfirm
                    title={`Отметить ${k === "pf" ? "все не посчитанные детали" : `${open.length} не посчитанных строк`} как «сходится»?`}
                    okText="Да"
                    cancelText="Нет"
                    onConfirm={() => allMatch.mutate(open)}
                  >
                    <Button size="small" loading={allMatch.isPending}>
                      Остальное сходится
                    </Button>
                  </Popconfirm>
                )
              }
            >
              {k === "pf" ? (
                <PfGroups
                  rows={rows}
                  onSetGroupCount={(partId, stageId, v) => setGroupCount.mutate({ partId, stageId, v })}
                  onRemoveExtra={(lineId) => removeExtra.mutate(lineId)}
                />
              ) : (
                <ResponsiveTable<PartCountLine>
                  tableKey={`stock-counts-lines-${k}`}
                  size="small"
                  rowKey="id"
                  dataSource={rows}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: "max-content" }}
                  columns={[
                    ...(k === "plenka"
                      ? [
                          {
                            title: "Рулон",
                            render: (_: unknown, l: PartCountLine) => (
                              <Space size={4} orientation="vertical">
                                <b>{rollNo(l.material_unit_id)}</b>
                                {l.elsewhere && <UiBadge color="orange">по учёту: {l.elsewhere}</UiBadge>}
                              </Space>
                            ),
                          },
                        ]
                      : []),
                    { title: "Наименование", dataIndex: "name" },
                    ...(k === "plenka"
                      ? [
                          { title: "Тип", dataIndex: "detail" },
                          { title: "Ячейка", render: (_: unknown, l: PartCountLine) => l.location_code ?? "—" },
                        ]
                      : [{ title: "Группа", render: (_: unknown, l: PartCountLine) => l.group_name ?? "—" }]),
                    { title: "По учёту", align: "right" as const, render: (_: unknown, l: PartCountLine) => `${fmt(l.expected_qty)} ${l.unit}` },
                    { title: "Факт", render: (_: unknown, l: PartCountLine) => qtyInput(l) },
                    ...(k === "plenka"
                      ? [
                          {
                            title: "",
                            render: (_: unknown, l: PartCountLine) =>
                              l.counted_qty == null && l.expected_qty > 0 ? (
                                <Space size={4}>
                                  <Button size="small" onClick={() => setCount.mutate({ lineId: l.id, v: l.expected_qty })}>
                                    есть
                                  </Button>
                                  <Button size="small" danger onClick={() => setCount.mutate({ lineId: l.id, v: 0 })}>
                                    нет
                                  </Button>
                                </Space>
                              ) : null,
                          },
                        ]
                      : []),
                    { title: "", render: (_: unknown, l: PartCountLine) => <DiffTag diff={l.diff} unit={l.unit} /> },
                    extraCol,
                  ]}
                />
              )}
            </Card>
          );
        })}

        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Button onClick={() => setExtraOpen(true)}>+ Найдено сверх листа</Button>
            <Popconfirm
              title="Отменить инвентаризацию? Введённый факт пропадёт, учёт не меняется."
              okText="Отменить"
              cancelText="Нет"
              onConfirm={() => cancel.mutate()}
            >
              <Button danger>Отменить инвентаризацию</Button>
            </Popconfirm>
          </Space>
          <Popconfirm
            title={left > 0 ? `Не посчитано ${left} — по ним учёт останется как есть. Закрыть?` : "Закрыть пересчёт?"}
            okText="Закрыть"
            cancelText="Нет"
            onConfirm={() => close.mutate()}
          >
            <Button type="primary" loading={close.isPending}>
              Закрыть пересчёт
            </Button>
          </Popconfirm>
        </Space>
      </Space>
      {extraOpen && <ExtraModal d={d} onClose={() => setExtraOpen(false)} onSaved={put} />}
    </Card>
  );
}

interface PfGroupRow {
  key: string;
  part_id: number;
  stage_id: number | null;
  name: string;
  dimensions?: string | null;
  group_name?: string | null;
  stage_name?: string | null;
  location_code?: string | null;
  expected_qty: number;
  counted_qty: number | null;
  diff: number | null;
  lines: PartCountLine[];
  isExtra: boolean;
}

/** П/ф — единый пересчёт по деталям (партии объединяются в одну строку на стеллаже). */
function PfGroups({
  rows,
  onSetGroupCount,
  onRemoveExtra,
}: {
  rows: PartCountLine[];
  onSetGroupCount: (partId: number, stageId: number | null, v: number | null) => void;
  onRemoveExtra: (lineId: number) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, PfGroupRow>();
    for (const ln of rows) {
      if (ln.part_id == null) continue;
      const key = `${ln.part_id}|${ln.stage_id ?? 0}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          part_id: ln.part_id,
          stage_id: ln.stage_id,
          name: ln.name,
          dimensions: ln.dimensions,
          group_name: ln.group_name,
          stage_name: ln.stage_name,
          location_code: ln.location_code,
          expected_qty: 0,
          counted_qty: 0,
          diff: null,
          lines: [],
          isExtra: true,
        };
        map.set(key, g);
      }
      g.lines.push(ln);
      g.expected_qty += ln.expected_qty;
      if (ln.location_code && !g.location_code) g.location_code = ln.location_code;
      if (ln.dimensions && !g.dimensions) g.dimensions = ln.dimensions;
      if (ln.expected_qty > 0 || ln.part_unit_id) g.isExtra = false;
    }
    for (const g of map.values()) {
      const hasUncounted = g.lines.some((l) => l.counted_qty == null);
      if (hasUncounted) {
        g.counted_qty = null;
        g.diff = null;
      } else {
        g.counted_qty = g.lines.reduce((s, l) => s + (l.counted_qty ?? 0), 0);
        g.diff = Math.round((g.counted_qty - g.expected_qty) * 1000) / 1000;
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [rows]);

  return (
    <ResponsiveTable<PfGroupRow>
      tableKey="stock-counts-pf-groups"
      size="small"
      rowKey="key"
      dataSource={groups}
      pagination={{ pageSize: 50 }}
      scroll={{ x: "max-content" }}
      columns={[
        {
          title: "Деталь / Наименование",
          dataIndex: "name",
          render: (_, g) => (
            <Space direction="vertical" size={2}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{g.name}</div>
              <Space wrap size={4}>
                {g.dimensions && <UiBadge color="blue">{g.dimensions}</UiBadge>}
                {g.stage_name && <UiBadge color="purple">{g.stage_name}</UiBadge>}
                {g.group_name && <span style={{ color: "#888", fontSize: 12 }}>{g.group_name}</span>}
              </Space>
            </Space>
          ),
        },
        {
          title: "Ячейка",
          render: (_, g) => (g.location_code ? <span>📍 {g.location_code}</span> : <span style={{ color: "#bbb" }}>—</span>),
        },
        {
          title: "Партии в учёте",
          render: (_, g) => (
            <Popover
              content={
                <div style={{ maxHeight: 220, overflowY: "auto", minWidth: 260 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Партии по учёту ({g.lines.length}):</div>
                  {g.lines.map((l) => (
                    <div
                      key={l.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        fontSize: 12,
                        padding: "3px 0",
                        borderBottom: "1px dashed #eee",
                      }}
                    >
                      <span>
                        {l.part_unit_id ? pfNo(l.part_unit_id) : "сверх листа"}{" "}
                        <span style={{ color: "#888" }}>
                          ({l.manufactured_at ? dayjs(l.manufactured_at).format("DD.MM.YY") : "—"})
                        </span>
                      </span>
                      <b>{fmt(l.expected_qty)} шт</b>
                    </div>
                  ))}
                </div>
              }
              trigger="hover"
            >
              <Tag style={{ cursor: "pointer", background: "#f5f5f5" }}>
                📦 {g.lines.length} {g.lines.length === 1 ? "партия" : g.lines.length < 5 ? "партии" : "партий"}
              </Tag>
            </Popover>
          ),
        },
        {
          title: "По учёту",
          align: "right",
          render: (_, g) => <span style={{ fontWeight: 700, fontSize: 14 }}>{fmt(g.expected_qty)} шт</span>,
        },
        {
          title: "Фактический остаток",
          render: (_, g) => (
            <Space size={6}>
              <InputNumber
                min={0}
                precision={0}
                inputMode="numeric"
                style={{ width: 105 }}
                defaultValue={g.counted_qty ?? undefined}
                placeholder={fmt(g.expected_qty)}
                key={`${g.key}-${g.counted_qty}`}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const v = raw === "" ? null : Number(raw.replace(",", "."));
                  if (v !== g.counted_qty && (v == null || !Number.isNaN(v))) {
                    onSetGroupCount(g.part_id, g.stage_id, v);
                  }
                }}
                onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
              />
              {g.counted_qty == null && (
                <Button
                  size="small"
                  type="link"
                  style={{ color: "#52c41a", padding: "0 4px" }}
                  onClick={() => onSetGroupCount(g.part_id, g.stage_id, g.expected_qty)}
                  title="Подтвердить учётное количество"
                >
                  Есть
                </Button>
              )}
            </Space>
          ),
        },
        {
          title: "Разница",
          render: (_, g) => <DiffTag diff={g.diff} unit="шт" />,
        },
        {
          title: "",
          render: (_, g) =>
            g.isExtra ? (
              <Button size="small" type="link" danger onClick={() => g.lines.forEach((l) => onRemoveExtra(l.id))}>
                убрать
              </Button>
            ) : null,
        },
      ]}
    />
  );
}

function ExtraModal({ d, onClose, onSaved }: { d: PartCountDetail; onClose: () => void; onSaved: (x: PartCountDetail) => void }) {
  const kinds = KIND_ORDER.filter((k) => d.kinds.includes(k));
  const [form] = Form.useForm<{ kind: CountKind; part_id?: number; item_id?: number; unit?: string; qty?: number }>();
  const kind = Form.useWatch("kind", form) ?? kinds[0];
  const partsQuery = useQuery({
    queryKey: ["area-parts", d.area],
    queryFn: () => listAreaParts(d.area!),
    enabled: kind === "pf" && !!d.area,
  });
  const itemsQuery = useQuery({
    queryKey: ["items", "count-extra", kind],
    queryFn: () => listItems({ kind: kind === "fg" ? "izdelie" : "material" }),
    enabled: kind === "material" || kind === "fg",
  });
  const add = useMutation({
    mutationFn: (form: { kind?: CountKind; part_id?: number; item_id?: number; unit?: string; qty?: number }) => {
      // выбор вида скрыт, когда вид один, — тогда его нет в значениях формы
      const v = { ...form, kind: form.kind ?? kinds[0] };
      if (v.kind === "plenka") {
        const lot = parseLotNo(v.unit ?? "");
        const id = lot?.kind === "plenka" ? lot.id : Number((v.unit ?? "").trim());
        if (!id) throw new Error("Номер рулона — число с бирки или ПЛ-1015");
        return addPartCountExtra(d.id, { kind: "plenka", material_unit_id: id, counted_qty: v.qty ?? null });
      }
      return addPartCountExtra(d.id, { kind: v.kind, part_id: v.part_id, item_id: v.item_id, counted_qty: v.qty });
    },
    onSuccess: (x) => {
      onSaved(x);
      onClose();
    },
    onError: (e) => message.error(e instanceof Error && !("response" in e) ? e.message : apiErrorMessage(e, "Не удалось добавить")),
  });
  return (
    <Modal
      open
      title="Найдено сверх листа"
      okText="Добавить"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() => form.submit()}
      okButtonProps={{ loading: add.isPending }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ kind: kinds[0] }} onFinish={(v) => add.mutate(v)}>
        {kinds.length > 1 && (
          <Form.Item name="kind" label="Что нашли">
            <Select options={kinds.map((k) => ({ value: k, label: COUNT_KIND_LABEL[k] }))} />
          </Form.Item>
        )}
        {kind === "plenka" && (
          <>
            <Typography.Paragraph type="secondary">
              Рулон, которого здесь по учёту нет (лежит в другом месте или списан). После закрытия его можно оприходовать сюда.
              Рулон без бирки заведите приёмкой без документа.
            </Typography.Paragraph>
            <Form.Item name="unit" label="Номер рулона" rules={[{ required: true, message: "Номер с бирки" }]}>
              <Input placeholder="ПЛ-1015 или число с бирки" />
            </Form.Item>
            <Form.Item name="qty" label="Сколько метров" extra="Пусто — сколько числится по учёту">
              <InputNumber min={0.01} style={{ width: "100%" }} inputMode="decimal" />
            </Form.Item>
          </>
        )}
        {kind === "pf" && (
          <>
            <Typography.Paragraph type="secondary">
              Деталь, которой на участке по учёту нет (или лишняя партия). После закрытия её можно оприходовать новой партией на
              этапе этого участка.
            </Typography.Paragraph>
            <Form.Item name="part_id" label="Деталь" rules={[{ required: true, message: "Выберите деталь" }]}>
              <Select
                showSearch
                optionFilterProp="label"
                loading={partsQuery.isLoading}
                placeholder="Деталь с операцией на этом участке"
                options={(partsQuery.data ?? []).map((p) => ({ value: p.part_id, label: `${p.part_name} · ${p.stage_name}` }))}
              />
            </Form.Item>
          </>
        )}
        {(kind === "material" || kind === "fg") && (
          <Form.Item name="item_id" label={kind === "fg" ? "Изделие" : "Материал"} rules={[{ required: true, message: "Выберите позицию" }]}>
            <Select
              showSearch
              optionFilterProp="label"
              loading={itemsQuery.isLoading}
              options={(itemsQuery.data ?? []).filter((i) => !i.is_model).map((i) => ({ value: i.id, label: i.name }))}
            />
          </Form.Item>
        )}
        {kind !== "plenka" && (
          <Form.Item name="qty" label="Сколько нашли" rules={[{ required: true, message: "Количество" }]}>
            <InputNumber min={0.01} precision={kind === "material" ? undefined : 0} style={{ width: "100%" }} inputMode="decimal" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

const DECISION_LABEL: Record<CountDecision, string> = { write_off: "списано", accept: "оприходовано", keep: "оставлено как есть" };

/** Итог закрытой инвентаризации: расхождения и решения — по строке или все сразу. */
function CountResult({ d }: { d: PartCountDetail }) {
  const qc = useQueryClient();
  const [writeOff, setWriteOff] = useState<PartCountLine[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | CountKind>("all");
  const activeKindsOrder: CountKind[] = d.place_type === "area" ? ["pf", "plenka", "material", "fg"] : ["plenka", "pf", "material", "fg"];
  const availableKinds = activeKindsOrder.filter((k) => d.kinds.includes(k) || d.lines.some((l) => l.kind === k));
  const rows = useMemo(() => {
    let ls = showAll ? d.lines : d.lines.filter((l) => l.diff);
    if (kindFilter !== "all") ls = ls.filter((l) => l.kind === kindFilter);
    return ls;
  }, [d.lines, showAll, kindFilter]);
  const pending = rows.filter((l) => l.allowed.length > 0);
  const shortages = pending.filter((l) => l.allowed.includes("write_off"));
  const surpluses = pending.filter((l) => l.allowed.includes("accept"));
  const done = (data: PartCountDetail) => {
    qc.setQueryData(["part-count", d.id], data);
    for (const k of ["part-counts", "part-units", "unified-lots", "unified-movements", "unified-stock", "part-stock", "material-stock", "fg-stock", "units"])
      qc.invalidateQueries({ queryKey: [k] });
    setWriteOff(null);
  };
  const resolve = useMutation({
    mutationFn: (v: { lines: PartCountLine[]; decision: CountDecision; reason?: string; note?: string }) =>
      v.lines.length === 1
        ? resolvePartCountLine(d.id, v.lines[0].id, { decision: v.decision, reason: v.reason, note: v.note })
        : resolvePartCountLines(d.id, { line_ids: v.lines.map((l) => l.id), decision: v.decision, reason: v.reason, note: v.note }),
    onSuccess: done,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось применить решение")),
  });
  const needsReason = (ls: PartCountLine[]) => ls.some((l) => l.kind === "plenka" || l.kind === "pf");
  const askWriteOff = (ls: PartCountLine[]) => (needsReason(ls) ? setWriteOff(ls) : resolve.mutate({ lines: ls, decision: "write_off" }));
  return (
    <Card
      title={`Инвентаризация №${d.id} · ${d.place_name}`}
      extra={d.lines_open > 0 ? <UiBadge color="orange">без решения: {d.lines_open}</UiBadge> : <UiBadge color="green">все решения приняты</UiBadge>}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {d.lines_open > 0 ? (
          <NextStep
            tone="action"
            title={`Решите расхождения: ${d.lines_open}`}
            text="Недостача — списать с причиной или оставить; излишек — оприходовать или оставить. Можно сразу всем — кнопками ниже. Пока не решено, остатки не поправлены."
          />
        ) : (
          <NextStep tone="done" title={d.lines_diff ? "Все решения приняты — остатки поправлены" : "Всё сошлось — расхождений нет"} />
        )}
        <Typography.Text type="secondary">
          Закрыта {d.closed_at ? dayjs(d.closed_at).format("DD.MM.YYYY HH:mm") : ""} · посчитано {d.lines_counted} из {d.lines_total} ·
          расхождений {d.lines_diff}
        </Typography.Text>
        {d.lines_diff === 0 && <Alert type="success" showIcon message="Всё сошлось — учёт не меняется" />}
        {pending.length > 1 && (
          <Space wrap>
            {shortages.length > 0 && (
              <Button danger onClick={() => askWriteOff(shortages)}>
                Списать все недостачи ({shortages.length})
              </Button>
            )}
            {surpluses.length > 0 && (
              <Popconfirm title={`Оприходовать все излишки (${surpluses.length})?`} okText="Да" cancelText="Нет" onConfirm={() => resolve.mutate({ lines: surpluses, decision: "accept" })}>
                <Button type="primary" loading={resolve.isPending}>
                  Оприходовать все излишки ({surpluses.length})
                </Button>
              </Popconfirm>
            )}
            <Popconfirm title={`Оставить как есть все ${pending.length} без решения?`} okText="Да" cancelText="Нет" onConfirm={() => resolve.mutate({ lines: pending, decision: "keep" })}>
              <Button loading={resolve.isPending}>Оставить все как есть</Button>
            </Popconfirm>
          </Space>
        )}
        <Space wrap size={16} align="center">
          {availableKinds.length > 1 && (
            <Segmented
              value={kindFilter}
              onChange={(v) => setKindFilter(v as "all" | CountKind)}
              options={[
                { label: `Все виды`, value: "all" },
                ...availableKinds.map((k) => ({
                  label: COUNT_KIND_LABEL[k],
                  value: k,
                })),
              ]}
            />
          )}
          <Checkbox checked={showAll} onChange={(e) => setShowAll(e.target.checked)}>
            показать все строки (включая сошедшиеся)
          </Checkbox>
        </Space>
        <ResponsiveTable<PartCountLine>
          tableKey="stock-counts-discrepancies"
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={{ pageSize: 50 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Вид", render: (_, l) => <UiBadge color={KIND_COLOR[l.kind]}>{COUNT_KIND_LABEL[l.kind]}</UiBadge> },
            {
              title: "Позиция",
              render: (_, l) => (
                <Space direction="vertical" size={2}>
                  <div><b>{l.name}</b></div>
                  <Space size={4} wrap>
                    {l.dimensions && <UiBadge color="blue">{l.dimensions}</UiBadge>}
                    {l.stage_name && <UiBadge color="purple">{l.stage_name}</UiBadge>}
                    {l.kind === "plenka" && l.detail && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {l.detail}
                      </Typography.Text>
                    )}
                    {l.group_name && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {l.group_name}
                      </Typography.Text>
                    )}
                  </Space>
                </Space>
              ),
            },
            {
              title: "Партия / рулон",
              render: (_, l) =>
                lotLabel(l) ?? (l.kind === "pf" ? <UiBadge color="orange">сверх листа</UiBadge> : <Typography.Text type="secondary">—</Typography.Text>),
            },
            { title: "По учёту", align: "right", render: (_, l) => `${fmt(l.expected_qty)} ${l.unit}` },
            { title: "Факт", align: "right", render: (_, l) => (l.counted_qty == null ? "—" : `${fmt(l.counted_qty)} ${l.unit}`) },
            {
              title: "",
              render: (_, l) => (
                <Space size={4} wrap>
                  <DiffTag diff={l.diff} unit={l.unit} />
                  {l.elsewhere && <UiBadge color="orange">по учёту: {l.elsewhere}</UiBadge>}
                </Space>
              ),
            },
            {
              title: "Решение",
              render: (_, l) =>
                l.decision ? (
                  <Typography.Text type="secondary">
                    {DECISION_LABEL[l.decision]}
                    {l.result_part_unit_id ? ` · партия ${pfNo(l.result_part_unit_id)}` : ""}
                  </Typography.Text>
                ) : l.allowed.length ? (
                  <Space size={4} wrap>
                    {l.allowed.includes("write_off") && (
                      <Button size="small" danger onClick={() => askWriteOff([l])}>
                        Списать {fmt(-(l.diff ?? 0))}
                      </Button>
                    )}
                    {l.allowed.includes("accept") && (
                      <Button size="small" type="primary" loading={resolve.isPending} onClick={() => resolve.mutate({ lines: [l], decision: "accept" })}>
                        {l.elsewhere ? "Перенести сюда" : `Оприходовать ${fmt(l.diff)}`}
                      </Button>
                    )}
                    <Button size="small" loading={resolve.isPending} onClick={() => resolve.mutate({ lines: [l], decision: "keep" })}>
                      Оставить как есть
                    </Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </Space>
      {writeOff && (
        <WriteOffShortage
          lines={writeOff}
          loading={resolve.isPending}
          onCancel={() => setWriteOff(null)}
          onOk={(reason, note) => resolve.mutate({ lines: writeOff, decision: "write_off", reason, note })}
        />
      )}
    </Card>
  );
}

function WriteOffShortage({
  lines,
  loading,
  onCancel,
  onOk,
}: {
  lines: PartCountLine[];
  loading: boolean;
  onCancel: () => void;
  onOk: (reason: string, note?: string) => void;
}) {
  const [form] = Form.useForm<{ reason: string; note?: string }>();
  // у плёнки — складские причины, у п/ф — причины по деталям; смешанный список — общий
  const cats = [...new Set(lines.filter((l) => l.kind === "plenka" || l.kind === "pf").map((l) => reasonCategory(l.kind)))];
  const cat = cats.length === 1 ? cats[0] : undefined;
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", cat ?? "all"], queryFn: () => listWriteOffReasons(cat as never) });
  const one = lines.length === 1 ? lines[0] : null;
  return (
    <Modal
      open
      title={one ? `Списать недостачу ${fmt(-(one.diff ?? 0))} ${one.unit} — ${lotLabel(one) ?? one.name}` : `Списать недостачи — строк ${lines.length}`}
      okText="Списать"
      okButtonProps={{ danger: true, loading }}
      cancelText="Отмена"
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => onOk(v.reason, v.note)}>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Выберите причину" }]}>
          <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
        </Form.Item>
        <Form.Item name="note" label="Комментарий">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}
