import { useMemo, useState } from "react";
import { Button, Input, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addMillingProgram, listMillingPrograms, patchMillingProgram, type MillingProgram } from "../../api/millingPrograms";
import { apiErrorMessage } from "../../utils/apiError";

/** Программы фрезеровки панелей (07.10): справочник для автоподбора. При
 * запуске строке фрезеровки подставляется программа, если по серии
 * (с подверсией из графика), ширине, молдингу и плёнке подходит ровно одна;
 * иначе — «уточнить у конструктора», вписывают в черновике. Вариант «_1» —
 * все плёнки, кроме ПЭТ; «_2» — ПЭТ. */
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
        («В-10.2»), ширина двери, молдинг («м5х3», «м9») и плёнка — вариант «_1» для всех плёнок, кроме ПЭТ, «_2» для ПЭТ. Серия Е —
        программы Е, В-28 — Grafiti 2, В-34 — Grafiti 5. Нестандартный размер — программу делает конструктор, её вписывают в
        черновике заказа.
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
          { title: "Плёнка", render: (_, p) => (p.variant === 2 ? "ПЭТ" : p.variant === 1 ? "кроме ПЭТ" : "любая") },
          { title: "Комментарий", render: (_, p) => p.note ?? "" },
          { title: "Действует", render: (_, p) => <Switch size="small" checked={p.is_active} onChange={() => toggle.mutate(p)} /> },
        ]}
      />
    </Space>
  );
}
