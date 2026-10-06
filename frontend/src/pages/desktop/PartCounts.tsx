import { useMemo, useState } from "react";
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
import { listAreas } from "../../api/areas";
import { listItemGroups, type ItemGroup } from "../../api/items";
import { listWriteOffReasons } from "../../api/writeOffReasons";
import {
  addPartCountExtra,
  cancelPartCount,
  closePartCount,
  getPartCount,
  listAreaParts,
  listPartCounts,
  removePartCountExtra,
  resolvePartCountLine,
  setPartCountLine,
  startPartCount,
  type PartCountDetail,
  type PartCountLine,
} from "../../api/partCounts";
import { STAGES } from "../../utils/itemAttrs";
import { apiErrorMessage } from "../../utils/apiError";
import { pfNo } from "../../utils/lotNo";

const fmt = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100) / 100}`);
const DiffTag = ({ diff }: { diff: number | null }) =>
  diff == null ? (
    <Tag>не считали</Tag>
  ) : diff === 0 ? (
    <Tag color="green">сошлось</Tag>
  ) : diff < 0 ? (
    <Tag color="red">недостача {fmt(-diff)}</Tag>
  ) : (
    <Tag color="orange">излишек {fmt(diff)}</Tag>
  );

/** Пересчёт п/ф на участке (инвентаризация п/ф, 06.10): п/ф лежат на участках
 * без бирок — участок пересчитывают по партиям; охват — участок, группы
 * номенклатуры и стадии. Расхождения не применяются сами — после закрытия
 * по каждой строке решение (списать / оприходовать / оставить). */
export default function PartCounts() {
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
      title="Пересчёт п/ф на участке"
      extra={
        <Button type="primary" onClick={() => setNewOpen(true)}>
          Новый пересчёт
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        П/ф лежат на участках без бирок — участок пересчитывают по партиям. Факт вводится по каждой партии; расхождения
        после закрытия решаются по строке: списать недостачу, оприходовать излишек или оставить как есть.
      </Typography.Paragraph>
      <Table
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data ?? []}
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
        onRow={(s) => ({ onClick: () => onOpen(s.id), style: { cursor: "pointer" } })}
        locale={{ emptyText: "Пересчётов ещё не было" }}
        columns={[
          { title: "№", dataIndex: "id", width: 60 },
          { title: "Участок", dataIndex: "area_name" },
          { title: "Начат", render: (_, s) => dayjs(s.started_at).format("DD.MM.YYYY HH:mm") },
          {
            title: "Статус",
            render: (_, s) =>
              s.status === "in_progress" ? (
                <Tag color="blue">идёт · посчитано {s.lines_counted} из {s.lines_total}</Tag>
              ) : s.lines_open > 0 ? (
                <Tag color="orange">закрыт · без решения {s.lines_open}</Tag>
              ) : (
                <Tag color="green">закрыт</Tag>
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

/** Дерево групп п/ф для охвата пересчёта. */
function groupTree(groups: ItemGroup[]): GroupNode[] {
  const pf = groups.filter((g) => g.kind_code === "pf");
  const build = (parent: number | null): GroupNode[] =>
    pf
      .filter((g) => g.parent_id === parent)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"))
      .map((g) => ({ value: g.id, title: g.name, children: build(g.id) }));
  return build(null);
}

function NewCountModal({ onClose, onStarted }: { onClose: () => void; onStarted: (id: number) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ area: string; group_ids: number[]; stages: string[]; note?: string }>();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const groupsQuery = useQuery({ queryKey: ["item-groups"], queryFn: listItemGroups });
  const tree = useMemo(() => groupTree(groupsQuery.data ?? []), [groupsQuery.data]);
  const start = useMutation({
    mutationFn: (v: { area: string; group_ids?: number[]; stages?: string[]; note?: string }) =>
      startPartCount({ area: v.area, scope: { group_ids: v.group_ids ?? [], stages: v.stages ?? [] }, note: v.note || null }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["part-counts"] });
      if (d.lines_total === 0) message.warning("В охвате на участке нет партий — можно вносить найденное сверх листа");
      onStarted(d.id);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось начать пересчёт")),
  });
  return (
    <Modal
      open
      title="Новый пересчёт п/ф"
      okText="Начать пересчёт"
      cancelText="Отмена"
      onCancel={onClose}
      onOk={() => form.submit()}
      okButtonProps={{ loading: start.isPending }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ area: user?.area ?? undefined, group_ids: [], stages: [] }} onFinish={(v) => start.mutate(v)}>
        <Form.Item name="area" label="Участок" rules={[{ required: true, message: "Выберите участок" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="Какой участок считаем"
            options={(areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }))}
          />
        </Form.Item>
        <Form.Item name="group_ids" label="Что считаем" extra="Пусто — все п/ф участка. Группа включает свои подгруппы.">
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
        <Form.Item name="stages" label="Стадия" extra="Пусто — все стадии.">
          <Checkbox.Group options={Object.entries(STAGES).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
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
  if (!q.data) return <Empty description="Пересчёт не найден" />;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Button type="link" style={{ padding: 0 }} onClick={onBack}>
        ← Все пересчёты
      </Button>
      {q.data.status === "in_progress" ? <CountSheet d={q.data} onBack={onBack} /> : <CountResult d={q.data} />}
    </Space>
  );
}

/** Партии, сгруппированные по детали и этапу. */
function useGroups(lines: PartCountLine[], filter: string, onlyOpen: boolean) {
  return useMemo(() => {
    const f = filter.trim().toLowerCase();
    const map = new Map<string, { key: string; part: string; group: string | null; stage: string; lines: PartCountLine[] }>();
    for (const ln of lines) {
      if (f && !ln.part_name.toLowerCase().includes(f) && !(ln.group_name ?? "").toLowerCase().includes(f)) continue;
      if (onlyOpen && ln.counted_qty != null) continue;
      const key = `${ln.part_id}|${ln.stage_id}`;
      const g = map.get(key) ?? { key, part: ln.part_name, group: ln.group_name, stage: ln.stage_name, lines: [] };
      g.lines.push(ln);
      map.set(key, g);
    }
    return [...map.values()];
  }, [lines, filter, onlyOpen]);
}

function CountSheet({ d, onBack }: { d: PartCountDetail; onBack: () => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const groups = useGroups(d.lines, filter, onlyOpen);
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

  return (
    <Card
      title={`Пересчёт ${pfNo(d.id)} · ${d.area_name}`}
      extra={<Tag color="blue">идёт</Tag>}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Input.Search allowClear placeholder="Деталь или группа" style={{ width: 260 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
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

        {groups.length === 0 && <Empty description={d.lines.length ? "Ничего не найдено" : "В охвате нет партий"} />}
        {groups.map((g) => {
          const exp = g.lines.reduce((s, l) => s + l.expected_qty, 0);
          const counted = g.lines.every((l) => l.counted_qty != null) ? g.lines.reduce((s, l) => s + (l.counted_qty ?? 0), 0) : null;
          const listed = g.lines.filter((l) => l.part_unit_id != null);
          return (
            <Card
              key={g.key}
              size="small"
              title={
                <Space wrap size={6}>
                  <span>{g.part}</span>
                  <Tag>{g.stage}</Tag>
                  {g.group && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.group}</Typography.Text>}
                </Space>
              }
              extra={
                <Space wrap>
                  <Typography.Text type="secondary">
                    по учёту {fmt(exp)} · факт {fmt(counted)} шт
                  </Typography.Text>
                  {listed.length > 0 && (
                    <Button size="small" loading={allMatch.isPending} onClick={() => allMatch.mutate(listed)}>
                      Всё сходится
                    </Button>
                  )}
                </Space>
              }
            >
              <Table<PartCountLine>
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={g.lines}
                scroll={{ x: "max-content" }}
                columns={[
                  {
                    title: "Партия",
                    render: (_, l) => (l.part_unit_id ? `${pfNo(l.part_unit_id)}` : <Tag color="orange">найдено сверх листа</Tag>),
                  },
                  { title: "Изготовлена", render: (_, l) => (l.manufactured_at ? dayjs(l.manufactured_at).format("DD.MM.YYYY") : "—") },
                  { title: "По учёту, шт", align: "right", render: (_, l) => fmt(l.expected_qty) },
                  {
                    title: "Факт, шт",
                    render: (_, l) => (
                      <InputNumber
                        min={0}
                        precision={0}
                        inputMode="numeric"
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
                    ),
                  },
                  { title: "", render: (_, l) => <DiffTag diff={l.diff} /> },
                  {
                    title: "",
                    render: (_, l) =>
                      l.part_unit_id == null ? (
                        <Button size="small" type="link" danger onClick={() => removeExtra.mutate(l.id)}>
                          убрать
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Card>
          );
        })}

        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Button onClick={() => setExtraOpen(true)}>+ Найдено сверх листа</Button>
            <Popconfirm title="Отменить пересчёт? Введённый факт пропадёт, учёт не меняется." okText="Отменить пересчёт" cancelText="Нет" onConfirm={() => cancel.mutate()}>
              <Button danger>Отменить пересчёт</Button>
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

function ExtraModal({ d, onClose, onSaved }: { d: PartCountDetail; onClose: () => void; onSaved: (x: PartCountDetail) => void }) {
  const [form] = Form.useForm<{ part_id: number; qty: number }>();
  const partsQuery = useQuery({ queryKey: ["area-parts", d.area], queryFn: () => listAreaParts(d.area) });
  const add = useMutation({
    mutationFn: (v: { part_id: number; qty: number }) => addPartCountExtra(d.id, v.part_id, v.qty),
    onSuccess: (x) => {
      onSaved(x);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить")),
  });
  return (
    <Modal open title="Найдено сверх листа" okText="Добавить" cancelText="Отмена" onCancel={onClose} onOk={() => form.submit()} okButtonProps={{ loading: add.isPending }} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Деталь, которой на участке по учёту нет (или лишняя партия). После закрытия её можно оприходовать новой партией на
        этапе этого участка.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => add.mutate(v)}>
        <Form.Item name="part_id" label="Деталь" rules={[{ required: true, message: "Выберите деталь" }]}>
          <Select
            showSearch
            optionFilterProp="label"
            loading={partsQuery.isLoading}
            placeholder="Деталь с операцией на этом участке"
            options={(partsQuery.data ?? []).map((p) => ({ value: p.part_id, label: `${p.part_name} · ${p.stage_name}` }))}
          />
        </Form.Item>
        <Form.Item name="qty" label="Сколько штук" rules={[{ required: true, message: "Количество" }]}>
          <InputNumber min={1} precision={0} style={{ width: "100%" }} inputMode="numeric" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Итог закрытого пересчёта: расхождения и решения по ним. */
function CountResult({ d }: { d: PartCountDetail }) {
  const qc = useQueryClient();
  const [writeOff, setWriteOff] = useState<PartCountLine | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? d.lines : d.lines.filter((l) => l.diff);
  const resolve = useMutation({
    mutationFn: (v: { line: PartCountLine; decision: "write_off" | "accept" | "keep"; reason?: string; note?: string }) =>
      resolvePartCountLine(d.id, v.line.id, { decision: v.decision, reason: v.reason, note: v.note }),
    onSuccess: (data) => {
      qc.setQueryData(["part-count", d.id], data);
      for (const k of ["part-counts", "part-units", "unified-lots", "unified-movements", "part-stock"]) qc.invalidateQueries({ queryKey: [k] });
      setWriteOff(null);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось применить решение")),
  });
  const label = { write_off: "списано", accept: "оприходовано", keep: "оставлено как есть" } as const;
  return (
    <Card
      title={`Пересчёт ${pfNo(d.id)} · ${d.area_name}`}
      extra={d.lines_open > 0 ? <Tag color="orange">без решения: {d.lines_open}</Tag> : <Tag color="green">все решения приняты</Tag>}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Закрыт {d.closed_at ? dayjs(d.closed_at).format("DD.MM.YYYY HH:mm") : ""} · посчитано {d.lines_counted} из {d.lines_total} ·
          расхождений {d.lines_diff}
        </Typography.Text>
        {d.lines_diff === 0 && <Alert type="success" showIcon message="Всё сошлось — учёт не меняется" />}
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
            { title: "Деталь", render: (_, l) => <>{l.part_name} <Tag>{l.stage_name}</Tag></> },
            { title: "Партия", render: (_, l) => (l.part_unit_id ? `${pfNo(l.part_unit_id)}` : <Tag color="orange">сверх листа</Tag>) },
            { title: "По учёту", align: "right", render: (_, l) => fmt(l.expected_qty) },
            { title: "Факт", align: "right", render: (_, l) => fmt(l.counted_qty) },
            { title: "", render: (_, l) => <DiffTag diff={l.diff} /> },
            {
              title: "Решение",
              render: (_, l) =>
                l.decision ? (
                  <Typography.Text type="secondary">
                    {label[l.decision]}
                    {l.result_part_unit_id ? ` · партия ${pfNo(l.result_part_unit_id)}` : ""}
                  </Typography.Text>
                ) : l.allowed.length ? (
                  <Space size={4} wrap>
                    {l.allowed.includes("write_off") && (
                      <Button size="small" danger onClick={() => setWriteOff(l)}>
                        Списать {fmt(-(l.diff ?? 0))}
                      </Button>
                    )}
                    {l.allowed.includes("accept") && (
                      <Button size="small" type="primary" loading={resolve.isPending} onClick={() => resolve.mutate({ line: l, decision: "accept" })}>
                        Оприходовать {fmt(l.diff)}
                      </Button>
                    )}
                    <Button size="small" loading={resolve.isPending} onClick={() => resolve.mutate({ line: l, decision: "keep" })}>
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
          line={writeOff}
          loading={resolve.isPending}
          onCancel={() => setWriteOff(null)}
          onOk={(reason, note) => resolve.mutate({ line: writeOff, decision: "write_off", reason, note })}
        />
      )}
    </Card>
  );
}

function WriteOffShortage({
  line,
  loading,
  onCancel,
  onOk,
}: {
  line: PartCountLine;
  loading: boolean;
  onCancel: () => void;
  onOk: (reason: string, note?: string) => void;
}) {
  const [form] = Form.useForm<{ reason: string; note?: string }>();
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });
  return (
    <Modal
      open
      title={`Списать недостачу ${fmt(-(line.diff ?? 0))} шт — партия ${pfNo(line.part_unit_id)}`}
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
