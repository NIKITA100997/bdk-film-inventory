import { Tag, Tooltip } from "antd";

/** Сверх задания при ламинации (07.10): у строки с плёнкой годных больше
 * задания на 3 шт (у стоевых — на 5) — подсветка на всех деталях. */
export const overAllowance = (partName: string | null | undefined) => (/стоев/i.test(partName ?? "") ? 5 : 3);

export function overExcess(line: { part_name: string | null; material: string | null; quantity_pieces: number }, produced: number): number {
  if (line.material == null) return 0;
  const excess = produced - line.quantity_pieces;
  return excess > overAllowance(line.part_name) ? excess : 0;
}

export default function OverProductionTag({
  line,
  produced,
  planned,
}: {
  line: { part_name: string | null; material: string | null; quantity_pieces: number };
  produced: number;
  /** true — ещё не сохранено (мастер набирает) */
  planned?: boolean;
}) {
  const excess = overExcess(line, produced);
  if (!excess) return null;
  return (
    <Tooltip title={`Задание — ${line.quantity_pieces} шт; допустимо сверху ${overAllowance(line.part_name)} шт`}>
      <Tag color="red" style={{ marginInlineEnd: 0 }}>
        {planned ? "будет " : ""}сверх задания +{Math.round(excess * 100) / 100}
      </Tag>
    </Tooltip>
  );
}
