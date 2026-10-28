import { useMemo, useState } from "react";
import NextStep from "../../components/NextStep";
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
  Progress,
  Select,
  Space,
  Spin,
  Table,
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
  startPartCount,
  type CountDecision,
  type CountKind,
  type CountPlace,
  type PartCountDetail,
  type PartCountLine,
} from "../../api/partCounts";
import { STAGES } from "../../utils/itemAttrs";
import { apiErrorMessage } from "../../utils/apiError";
import { parseLotNo, pfNo, rollNo } from "../../utils/lotNo";

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 1000) / 1000}`.replace(".", ","));
const KIND_COLOR: Record<CountKind, string> = { plenka: "blue", pf: "orange", material: "cyan", fg: "green" };
const KIND_ORDER: CountKind[] = ["plenka", "pf", "material", "fg"];
const SECTION_TITLE: Record<CountKind, string> = {
  plenka: "Плёнка — рулоны и штрипсы",
  pf: "П/ф — по партиям",
  material: "Материалы",
  fg: "Готовые изделия",
};
const lotLabel = (l: PartCountLine) =>
  l.kind === "plenka" ? rollNo(l.material_unit_id) : l.kind === "pf" ? (l.part_unit_id ? pfNo(l.part_unit_id) : null) : null;
const reasonCategory = (k: CountKind) => (k === "plenka" ? "warehouse" : "parts");

const DiffTag = ({ diff, unit }: { diff: number | null; unit?: string }) =>
  diff == null ? (
    <Tag>не считали</Tag>
  ) : diff === 0 ? (
    <Tag color="green">сошлось</Tag>
  ) : diff < 0 ? (
    <Tag color="red">
      недостача {fmt(-diff)} {unit}
    </Tag>
  ) : (
    <Tag color="orange">
      излишек {fmt(diff)} {unit}
    </Tag>
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
  const [newOpen, setNewOpen] = useState(false);
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
      <Table
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
                {s.kinds.map((k) => (
                  <Tag key={k} color={KIND_COLOR[k]}>
                    {COUNT_KIND_LABEL[k]}
                  </Tag>
                ))}
              </Space>
            ),
          },
          { title: "Начата", render: (_, s) => dayjs(s.started_at).format("DD.MM.YYYY HH:mm") },
          {
            title: "Статус",
            render: (_, s) =>
              s.status === "in_progress" ? (
                <Tag color="blue">
                  идёт · посчитано {s.lines_counted} из {s.lines_total}
                </Tag>
              ) : s.lines_open > 0 ? (
                <Tag color="orange">закрыта · без решения {s.lines_open}</Tag>
              ) : (
                <Tag color="green">закрыта</Tag>
              ),
          },
          { title: "Расхождений", dataIndex: "lines_diff", align: "right" },
          { title: "Заметка", render: (_, s) => s.note ?? "" },
        ]}
      />
      {newOpen && <NewCountModal onClose={() => setNewOpen(false)} onStarted={(id) => onOpen(id)} />}
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

function NewCountModal({ onClose, onStarted }: { onClose: () => void; onStarted: (id: number) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ place: string; group_ids: number[]; stages: string[]; note?: string }>();
  const placesQuery = useQuery({ queryKey: ["count-places"], queryFn: listCountPlaces });
  const groupsQuery = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const tree = useMemo(() => groupTree(groupsQuery.data ?? []), [groupsQuery.data]);
  const places = placesQuery.data ?? [];
  const placeVal = Form.useWatch("place", form);
  const place = places.find((p) => placeKey(p) === placeVal);
  const grouped = useMemo(() => {
    const m = new Map<string, CountPlace[]>();
    for (const p of places) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()].map(([label, ps]) => ({ label, options: ps.map((p) => ({ value: placeKey(p), label: p.name })) }));
  }, [places]);
  const myArea = user?.area ? places.find((p) => p.place_type === "area" && p.place_ref === user.area) : undefined;
  const start = useMutation({
    mutationFn: (v: { place: string; group_ids?: number[]; stages?: string[]; note?: string }) => {
      const p = places.find((x) => placeKey(x) === v.place)!;
      return startPartCount({
        place_type: p.place_type,
        place_ref: p.place_ref,
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
        initialValues={{ place: myArea ? placeKey(myArea) : undefined, group_ids: [], stages: [] }}
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
                  <Tag key={k} color={KIND_COLOR[k]}>
                    {COUNT_KIND_LABEL[k]}
                  </Tag>
                ))}
              </span>
            ) : undefined
          }
        >
          <Select showSearch optionFilterProp="label" placeholder="Где считаем" loading={placesQuery.isLoading} options={grouped} />
        </Form.Item>
        {place?.place_type === "area" && place.kinds.includes("pf") && (
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
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" style={{ padding: 0 }} onClick={onBack}>
        ← Все инвентаризации
      </Button>
      {q.data.status === "in_progress" ? <CountSheet d={q.data} onBack={onBack} /> : <CountResult d={q.data} />}
    </Space>
  );
}

function matches(l: PartCountLine, f: string) {
  if (!f) return true;
  return [l.name, l.group_name, l.detail, lotLabel(l), l.location_code].some((x) => (x ?? "").toLowerCase().includes(f));
}

function CountSheet({ d, onBack }: { d: PartCountDetail; onBack: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [scan, setScan] = useState("");
  const put = (data: PartCountDetail) => {
    qc.setQueryData(["part-count", d.id], data);
    qc.invalidateQueries({ queryKey: ["part-counts"] });
  };
  const setCount = useMutation({
    mutationFn: ({ lineId, v }: { lineId: number; v: number | null }) => setPartCountLine(d.id, lineId, v),
    onSuccess: put,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить факт")),
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
  const kinds = KIND_ORDER.filter((k) => d.kinds.includes(k) || visible.some((l) => l.kind === k));

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
    <Card title={`Инвентаризация №${d.id} · ${d.place_name}`} extra={<Tag color="blue">идёт</Tag>}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {left > 0 ? (
          <NextStep
            tone="action"
            title={`Посчитайте: осталось ${left} из ${d.lines_total}`}
            text={
              d.kinds.includes("plenka") || d.kinds.includes("pf")
                ? "Сканируйте бирки (или вводите номер) — «Есть»; количество — в строке. Найденное не по листу — «Найдено сверх листа». Сошлось целым разделом — «Остальное сходится»."
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
          <Space wrap>
            {(d.kinds.includes("plenka") || d.kinds.includes("pf")) && (
              <Input.Search
                placeholder="Бирка: ПЛ-1015, ПФ-193 или число"
                enterButton="Есть"
                style={{ width: 320 }}
                value={scan}
                loading={found.isPending}
                onChange={(e) => setScan(e.target.value)}
                onSearch={onScan}
              />
            )}
            <Input.Search allowClear placeholder="Поиск в листе" style={{ width: 240 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
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
        {kinds.map((k) => {
          const rows = visible.filter((l) => l.kind === k);
          if (!rows.length && !d.lines.some((l) => l.kind === k)) return null;
          const open = rows.filter((l) => l.counted_qty == null && l.expected_qty > 0);
          return (
            <Card
              key={k}
              size="small"
              title={
                <Space size={8}>
                  <Tag color={KIND_COLOR[k]}>{COUNT_KIND_LABEL[k]}</Tag>
                  <span>{SECTION_TITLE[k]}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    строк {rows.length}
                  </Typography.Text>
                </Space>
              }
              extra={
                open.length > 0 && (
                  <Popconfirm
                    title={`Отметить ${open.length} не посчитанных как «сходится»?`}
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
                <PfGroups rows={rows} qtyInput={qtyInput} extraCol={extraCol} />
              ) : (
                <Table<PartCountLine>
                  size="small"
                  rowKey="id"
                  dataSource={rows}
                  pagination={rows.length > 50 ? { pageSize: 50 } : false}
                  scroll={{ x: "max-content" }}
                  columns={[
                    ...(k === "plenka"
                      ? [
                          {
                            title: "Рулон",
                            render: (_: unknown, l: PartCountLine) => (
                              <Space size={4} direction="vertical">
                                <b>{rollNo(l.material_unit_id)}</b>
                                {l.elsewhere && <Tag color="orange">по учёту: {l.elsewhere}</Tag>}
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

/** П/ф — партии, сгруппированные по детали и этапу. */
function PfGroups({
  rows,
  qtyInput,
  extraCol,
}: {
  rows: PartCountLine[];
  qtyInput: (l: PartCountLine) => React.ReactNode;
  extraCol: { title: string; render: (_: unknown, l: PartCountLine) => React.ReactNode };
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; part: string; group: string | null; stage: string | null; lines: PartCountLine[] }>();
    for (const ln of rows) {
      const key = `${ln.part_id}|${ln.stage_id}`;
      const g = map.get(key) ?? { key, part: ln.name, group: ln.group_name, stage: ln.stage_name, lines: [] };
      g.lines.push(ln);
      map.set(key, g);
    }
    return [...map.values()];
  }, [rows]);
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      {groups.map((g) => {
        const exp = g.lines.reduce((s, l) => s + l.expected_qty, 0);
        const counted = g.lines.every((l) => l.counted_qty != null) ? g.lines.reduce((s, l) => s + (l.counted_qty ?? 0), 0) : null;
        return (
          <div key={g.key}>
            <Space wrap size={6} style={{ marginBottom: 4 }}>
              <b>{g.part}</b>
              {g.stage && <Tag>{g.stage}</Tag>}
              {g.group && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {g.group}
                </Typography.Text>
              )}
              <Typography.Text type="secondary">
                · по учёту {fmt(exp)} · факт {fmt(counted)} шт
              </Typography.Text>
            </Space>
            <Table<PartCountLine>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={g.lines}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Партия", render: (_, l) => (l.part_unit_id ? pfNo(l.part_unit_id) : <Tag color="orange">найдено сверх листа</Tag>) },
                { title: "Изготовлена", render: (_, l) => (l.manufactured_at ? dayjs(l.manufactured_at).format("DD.MM.YYYY") : "—") },
                { title: "По учёту, шт", align: "right", render: (_, l) => fmt(l.expected_qty) },
                { title: "Факт, шт", render: (_, l) => qtyInput(l) },
                { title: "", render: (_, l) => <DiffTag diff={l.diff} /> },
                extraCol,
              ]}
            />
          </div>
        );
      })}
    </Space>
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
  const rows = showAll ? d.lines : d.lines.filter((l) => l.diff);
  const pending = d.lines.filter((l) => l.allowed.length > 0);
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
      extra={d.lines_open > 0 ? <Tag color="orange">без решения: {d.lines_open}</Tag> : <Tag color="green">все решения приняты</Tag>}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
        <Checkbox checked={showAll} onChange={(e) => setShowAll(e.target.checked)}>
          показать все строки
        </Checkbox>
        <Table<PartCountLine>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={{ pageSize: 50 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Вид", render: (_, l) => <Tag color={KIND_COLOR[l.kind]}>{COUNT_KIND_LABEL[l.kind]}</Tag> },
            {
              title: "Позиция",
              render: (_, l) => (
                <>
                  {l.name} {l.stage_name && <Tag>{l.stage_name}</Tag>}
                  {l.kind === "plenka" && l.detail && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {l.detail}
                    </Typography.Text>
                  )}
                </>
              ),
            },
            {
              title: "Партия / рулон",
              render: (_, l) =>
                lotLabel(l) ?? (l.kind === "pf" ? <Tag color="orange">сверх листа</Tag> : <Typography.Text type="secondary">—</Typography.Text>),
            },
            { title: "По учёту", align: "right", render: (_, l) => `${fmt(l.expected_qty)} ${l.unit}` },
            { title: "Факт", align: "right", render: (_, l) => (l.counted_qty == null ? "—" : `${fmt(l.counted_qty)} ${l.unit}`) },
            {
              title: "",
              render: (_, l) => (
                <Space size={4} wrap>
                  <DiffTag diff={l.diff} unit={l.unit} />
                  {l.elsewhere && <Tag color="orange">по учёту: {l.elsewhere}</Tag>}
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
