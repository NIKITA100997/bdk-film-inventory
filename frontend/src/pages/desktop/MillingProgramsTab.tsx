import { useMemo, useState } from "react";
import { Button, Input, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMillingProgram,
  listMillingBindings,
  listMillingPrograms,
  patchMillingProgram,
  setMillingBinding,
  type MillingBinding,
  type MillingProgram,
} from "../../api/millingPrograms";
import { listItems } from "../../api/items";
import { apiErrorMessage } from "../../utils/apiError";

/** Программы фрезеровки панелей (07.10): справочник для автоподбора. При
 * запуске строке фрезеровки подставляется программа, если по серии
 * (с подверсией из графика), ширине, молдингу и плёнке подходит ровно одна;
 * иначе — «уточнить у конструктора», вписывают в черновике. «_1» и «_2» —
 * стороны несимметричной двери (половина панелей по одной, половина по
 * другой). Изделию можно привязать программы вручную — главнее подбора. */
export default function MillingProgramsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["milling-programs"], queryFn: listMillingPrograms });
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => addMillingProgram(name.trim()),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["milling-programs"] });
      setName("");
      message.success(p.series ? `Добавлена: серия ${p.series}` : "Добавлена — название не разобрано, автоподбор её не предложит");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить")),
  });
  const toggle = useMutation({
    mutationFn: (p: MillingProgram) => patchMillingProgram(p.id, { is_active: !p.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["milling-programs"] }),
  });
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || (p.series ?? "").toLowerCase().includes(f));
  }, [q.data, filter]);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 860, margin: 0 }}>
        Программа подставляется в строку фрезеровки при запуске заказа, если подходит ровно одна: серия с подверсией из графика
        («В-10.2»; без неё — «.2» для ПЭТ, «.1» для остальных), ширина двери и молдинг («м5х3», «м9»). «_1» и «_2» — стороны
        несимметричной двери: половина панелей по одной программе, половина по другой. Серия Е — программы Е, В-28 — Grafiti 2,
        В-34 — Grafiti 5. Нестандартный размер — программу делает конструктор: привяжите её к изделию ниже или впишите в черновике.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search allowClear placeholder="Программа или серия" style={{ width: 260 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Input placeholder="Новая программа, например В15.2_600х2000_(М5х3)" style={{ width: 360 }} value={name} onChange={(e) => setName(e.target.value)} onPressEnter={() => name.trim() && add.mutate()} />
        <Button type="primary" disabled={!name.trim()} loading={add.isPending} onClick={() => add.mutate()}>
          Добавить
        </Button>
      </Space>
      <Table<MillingProgram>
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Программа", render: (_, p) => <Typography.Text strong={p.is_active} delete={!p.is_active}>{p.name}</Typography.Text> },
          { title: "Серия", render: (_, p) => p.series ?? <Tag color="orange">не разобрано</Tag> },
          { title: "Подверсия", render: (_, p) => p.version ?? "любая" },
          { title: "Ширина", render: (_, p) => p.width ?? "любая" },
          { title: "Молдинг", render: (_, p) => p.molding ?? "—" },
          { title: "Сторона", render: (_, p) => (p.variant ? `сторона ${p.variant}` : "обе") },
          { title: "Комментарий", render: (_, p) => p.note ?? "" },
          { title: "Действует", render: (_, p) => <Switch size="small" checked={p.is_active} onChange={() => toggle.mutate(p)} /> },
        ]}
      />
      <Bindings programs={(q.data ?? []).filter((p) => p.is_active)} />
    </Space>
  );
}

/** Привязка программ к изделиям (20.10): у двери — свои программы вместо
 * автоподбора (нестандарт, исключения). Одна — обе стороны, две — стороны 1 и 2. */
function Bindings({ programs }: { programs: MillingProgram[] }) {
  const qc = useQueryClient();
  const bq = useQuery({ queryKey: ["milling-bindings"], queryFn: listMillingBindings });
  const [search, setSearch] = useState("");
  const iq = useQuery({
    queryKey: ["items-search", search],
    queryFn: () => listItems({ kind: "izdelie", q: search }),
    enabled: search.trim().length >= 2,
  });
  const [itemId, setItemId] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (p: { itemId: number; programs: string[] }) => setMillingBinding(p.itemId, p.programs),
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["milling-bindings"] });
      setItemId(null);
      setPicked([]);
      message.success(p.programs.length ? "Программы привязаны" : "Привязка убрана — снова автоподбор");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const progOptions = programs.map((p) => ({ value: p.name, label: p.name }));
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: "8px 0 0" }}>
        Привязка к изделиям
      </Typography.Title>
      <Typography.Text type="secondary">
        Программы, заданные изделию вручную, ставятся при запуске вместо автоподбора: одна — на обе стороны, две — сторона 1 и сторона 2.
      </Typography.Text>
      <Space wrap>
        <Select
          showSearch
          style={{ width: 420 }}
          placeholder="Изделие: начните вводить название (от 2 букв)"
          filterOption={false}
          onSearch={setSearch}
          loading={iq.isFetching}
          value={itemId ?? undefined}
          onChange={(v) => {
            setItemId(v);
            setPicked(bq.data?.find((b) => b.item_id === v)?.programs ?? []);
          }}
          options={(iq.data ?? []).slice(0, 50).map((i) => ({ value: i.id, label: i.name }))}
          notFoundContent={search.trim().length < 2 ? "Введите 2+ буквы" : "Не найдено"}
        />
        <Select
          mode="multiple"
          style={{ width: 420 }}
          placeholder="Программы (одна или две)"
          value={picked}
          maxCount={2}
          onChange={setPicked}
          options={progOptions}
          optionFilterProp="label"
        />
        <Button type="primary" disabled={!itemId || !picked.length} loading={save.isPending} onClick={() => itemId && save.mutate({ itemId, programs: picked })}>
          Привязать
        </Button>
      </Space>
      <Table<MillingBinding>
        size="small"
        rowKey="item_id"
        loading={bq.isLoading}
        dataSource={bq.data ?? []}
        pagination={{ pageSize: 30 }}
        locale={{ emptyText: "Привязок нет — программы подбираются автоматически" }}
        columns={[
          { title: "Изделие", dataIndex: "item_name" },
          {
            title: "Программы",
            render: (_, b) => (
              <Space size={4} wrap>
                {b.programs.map((p, i) => (
                  <Tag key={p}>{b.programs.length > 1 ? `сторона ${i + 1}: ` : ""}{p}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "",
            width: 120,
            render: (_, b) => (
              <Popconfirm title="Убрать привязку? Программа снова будет подбираться автоматически." onConfirm={() => save.mutate({ itemId: b.item_id, programs: [] })}>
                <Button size="small">Убрать</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );
}
