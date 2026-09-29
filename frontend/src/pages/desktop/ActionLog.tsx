import { Card } from "antd";
import { MovementsPanel } from "./StockLotsMovements";

/** Журнал действий — тот же единый журнал движений, что в «Остатках →
 * Движения» (объединение экранов, 29.09): плёнка и п/ф одной лентой,
 * фильтры по событию, участку, партии, исправление ошибок по правам. */
export default function ActionLog() {
  return (
    <Card title="Журнал действий">
      <MovementsPanel defaultDays={30} />
    </Card>
  );
}
