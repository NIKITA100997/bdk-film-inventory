import { Card, Space, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getBlanksDemand, type BlankDemandLine } from "../../api/production";
import ReportTable, { type ReportColumn } from "../../components/ReportTable";
import CuttingHistory from "./CuttingHistory";

function DeficitTag({ value }: { value: number }) {
  if (value <= 0) return <Tag color="green">запас {Math.abs(value)} м</Tag>;
  return <Tag color={value >= 100 ? "red" : "orange"}>режьте {value} м</Tag>;
}

/** Свободный остаток (раздел про склад, который должен резать заранее —
 * назывался «Заготовки», переименовано: слово «заготовка» освобождено
 * под физический учёт деталей п/ф/заготовка, см. PartUnit) — сколько
 * плёнки этой позиции и ширины ещё нужно по ВСЕМ активным заданиям (не
 * только уже распределённым по дням/линиям, как очередь «Выдача участку»)
 * в сравнении с тем, что уже нарезано и лежит на складе никому не
 * назначенным (production_task_line_id IS NULL — структурно и есть
 * свободный остаток). Резать по-прежнему через карточку единицы
 * («Разделить») — этот экран только показывает, где резать в первую
 * очередь. */
function BlanksDemandTab() {
  const query = useQuery({ queryKey: ["blanks-demand"], queryFn: getBlanksDemand });
  const rows = query.data ?? [];

  const columns: ReportColumn<BlankDemandLine>[] = [
    {
      key: "material",
      header: "Материал",
      render: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`,
      printValue: (r) => `${r.material}, ${r.color}, ${r.thickness} мм`,
    },
    {
      key: "width_mm",
      header: "Ширина, мм",
      render: (r) => r.width_mm,
      printValue: (r) => r.width_mm,
      sorter: (a, b) => a.width_mm - b.width_mm,
    },
    {
      key: "needed_length_m",
      header: "Нужно по заданиям, м",
      render: (r) => r.needed_length_m,
      printValue: (r) => r.needed_length_m,
      sorter: (a, b) => a.needed_length_m - b.needed_length_m,
    },
    {
      key: "on_hand_length_m",
      header: "Остаток на складе, м",
      render: (r) => r.on_hand_length_m,
      printValue: (r) => r.on_hand_length_m,
      sorter: (a, b) => a.on_hand_length_m - b.on_hand_length_m,
    },
    {
      key: "deficit_length_m",
      header: "Дефицит / запас",
      render: (r) => <DeficitTag value={r.deficit_length_m} />,
      printValue: (r) => r.deficit_length_m,
      sorter: (a, b) => a.deficit_length_m - b.deficit_length_m,
      defaultSortOrder: "descend",
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Потребность считается по всем активным заданиям цеха целиком — включая ещё не распределённые по дням и
        линиям, то есть до того, как участок формально «пришёл» за плёнкой. Строки сверху (самый большой дефицит) —
        резать в первую очередь, чтобы производство не ждало. Сама нарезка — как обычно, через карточку единицы
        («Разделить»); этот экран только показывает, где резать выгоднее всего.
      </Typography.Paragraph>
      <ReportTable
        title="Свободный остаток"
        filename="zagotovki.csv"
        rowKey={(r) => `${r.material}-${r.color}-${r.thickness}-${r.width_mm}`}
        columns={columns}
        data={rows}
        loading={query.isLoading}
      />
    </Space>
  );
}

/** Свободный остаток (раздел про склад, который должен резать заранее —
 * назывался «Заготовки») — вкладка «Потребность» (сколько нужно по
 * заданиям vs сколько уже нарезано про запас) и вкладка «История резки»
 * (раздел про отмену резки) — журнал каждой резки с возможностью
 * отменить, распечатать этикетки, разрезать донора ещё раз. */
export default function Blanks() {
  return (
    <Card title="Свободный остаток">
      <Tabs
        items={[
          { key: "demand", label: "Потребность", children: <BlanksDemandTab /> },
          { key: "history", label: "История резки", children: <CuttingHistory /> },
        ]}
      />
    </Card>
  );
}
