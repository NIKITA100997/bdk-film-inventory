import { Space, Tag, Tooltip, Typography } from "antd";
import type { PartReserve } from "../api/pfDemand";

const fmt = (n: number) => Math.round(n * 100) / 100;

/** «В резерве N · свободно M» с раскладкой по заданиям в подсказке. */
export default function PfReserveCell({ reserve }: { reserve: PartReserve | undefined }) {
  if (!reserve) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Tooltip
      title={
        <Space direction="vertical" size={0}>
          {reserve.tasks.map((t) => (
            <span key={t.task_id}>
              №{t.task_id} · {t.task_name}: {fmt(t.reserved)} шт
            </span>
          ))}
        </Space>
      }
    >
      <Space size={4} wrap>
        <Tag color="purple" style={{ margin: 0 }}>
          в резерве {fmt(reserve.reserved)}
        </Tag>
        <Typography.Text>свободно {fmt(reserve.free)}</Typography.Text>
      </Space>
    </Tooltip>
  );
}
