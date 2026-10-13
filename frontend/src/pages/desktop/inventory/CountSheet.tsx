import { useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Space, Switch, Typography, message } from "antd";
import dayjs from "dayjs";
import ResponsiveTable from "../../../components/ResponsiveTable";

export interface CountRow {
  key: string;
  name: string;
  /** площадка, счёт, группа — что отличает строки одной позиции */
  detail?: string | null;
  unit: string;
  book: number;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** Пересчёт листом (14.10) — одинаковый для материалов и склада ГП:
 * по учёту → вводите факт → разница видна сразу → «Провести» записывает
 * только расхождения одним документом. Пустой факт — строку не трогаем. */
export default function CountSheet({
  rows,
  loading,
  onPost,
  hint,
}: {
  rows: CountRow[];
  loading: boolean;
  onPost: (doc: string, facts: { key: string; fact: number }[]) => Promise<{ changed: number; checked: number }>;
  hint: string;
}) {
  const [facts, setFacts] = useState<Record<string, number | null>>({});
  const [doc, setDoc] = useState(`Инвентаризация ${dayjs().format("DD.MM.YYYY")}`);
  const [q, setQ] = useState("");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [posting, setPosting] = useState(false);
  const diff = (r: CountRow) => (facts[r.key] == null ? null : (facts[r.key] as number) - r.book);
  const entered = rows.filter((r) => facts[r.key] != null);
  const withDiff = entered.filter((r) => Math.abs(diff(r)!) > 1e-9);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) => (!needle || `${r.name} ${r.detail ?? ""}`.toLowerCase().includes(needle)) && (!onlyDiff || (diff(r) != null && Math.abs(diff(r)!) > 1e-9)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, onlyDiff, facts]);
  const post = async () => {
    setPosting(true);
    try {
      const r = await onPost(doc.trim(), entered.map((x) => ({ key: x.key, fact: facts[x.key] as number })));
      message.success(`Проведено: расхождений ${r.changed} из ${r.checked} пересчитанных`);
      setFacts({});
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Не удалось провести");
    } finally {
      setPosting(false);
    }
  };
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {hint} Введите факт там, где пересчитали; пустые строки не трогаются. «Провести» запишет только расхождения — одним
        документом, в журнале движений их видно с этим названием.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search allowClear placeholder="Позиция" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Space size={6}>
          <Switch size="small" checked={onlyDiff} onChange={setOnlyDiff} />
          <Typography.Text>только расхождения</Typography.Text>
        </Space>
        <Input style={{ width: 260 }} value={doc} onChange={(e) => setDoc(e.target.value)} addonBefore="Документ" />
        <Button type="primary" disabled={!entered.length || !doc.trim()} loading={posting} onClick={post}>
          Провести ({withDiff.length} расх. из {entered.length})
        </Button>
        {entered.length > 0 && <Button onClick={() => setFacts({})}>Очистить</Button>}
      </Space>
      {withDiff.length > 0 && (
        <Alert
          type="info"
          showIcon
          message={`Расхождений: ${withDiff.length}. Излишек ${withDiff.filter((r) => diff(r)! > 0).length}, недостача ${withDiff.filter((r) => diff(r)! < 0).length}.`}
        />
      )}
      <ResponsiveTable<CountRow>
        tableKey="count-sheet"
        lockedColumns={["Позиция"]}
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={shown}
        pagination={{ pageSize: 100 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Нечего пересчитывать" }}
        columns={[
          { title: "Позиция", render: (_, r) => r.name },
          { title: "Где / что", render: (_, r) => r.detail ?? "—" },
          { title: "По учёту", align: "right", render: (_, r) => `${n(r.book)} ${r.unit}` },
          {
            title: "Факт",
            render: (_, r) => (
              <InputNumber
                size="small"
                min={0}
                step={0.1}
                style={{ width: 110 }}
                value={facts[r.key] ?? null}
                onChange={(v) => setFacts((f) => ({ ...f, [r.key]: v }))}
                placeholder="—"
              />
            ),
          },
          {
            title: "Разница",
            align: "right",
            render: (_, r) => {
              const d = diff(r);
              if (d == null) return "";
              if (Math.abs(d) < 1e-9) return <Typography.Text type="success">сходится</Typography.Text>;
              return <Typography.Text type={d < 0 ? "danger" : "warning"}>{d > 0 ? "+" : ""}{n(d)} {r.unit}</Typography.Text>;
            },
          },
        ]}
      />
    </Space>
  );
}
