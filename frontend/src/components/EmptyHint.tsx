import { Empty } from "antd";

/** Единообразное пустое состояние (9.5 раздел бэклога доработок) — раньше
 * часть экранов просто показывала пустое место без подсказки первого шага. */
export default function EmptyHint({ description }: { description: string }) {
  return <Empty description={description} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: "32px 0" }} />;
}
