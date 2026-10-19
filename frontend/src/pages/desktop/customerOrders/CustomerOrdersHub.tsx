import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import SectionTabs from "../../../components/SectionTabs";
import CustomerOrders from "./CustomerOrders";
import OrderReadiness from "../OrderReadiness";
import OrderDeadlines from "../production/OrderDeadlines";
import { ShipmentsBody } from "../Shipments";
import BitrixDeals from "./BitrixDeals";

/** Заказы клиентов (14.10) — одним пунктом: сами заказы, готовность по
 * этапам (бывший «Готовность заказов» в продажах), сроки с переносами
 * (бывший «Сроки заказов» в производстве) и отгрузка по счёту (бывший
 * отдельный пункт «Отгрузка») — это всё про обещания клиенту. */
export default function CustomerOrdersHub() {
  const { user } = useAuth();
  const sections = [
    ...(hasPerm(user, "production_tasks.manage", "production_tasks.view", "production_tasks.report", "orders.request", "sales_calculator.view", "plan.approve")
      ? [{ key: "orders", label: "Заказы", children: <CustomerOrders /> }]
      : []),
    ...(hasPerm(user, "sales_calculator.view", "production_tasks.manage", "production_tasks.view", "production_tasks.report")
      ? [{ key: "readiness", label: "Готовность по этапам", children: <OrderReadiness /> }]
      : []),
    ...(hasPerm(user, "production_tasks.manage", "production_tasks.view", "orders.request", "sales_calculator.view", "plan.approve")
      ? [{ key: "deadlines", label: "Сроки и переносы", children: <OrderDeadlines /> }]
      : []),
    // сделки воронки Битрикс24 против заказов (19.10)
    ...(hasPerm(user, "production_tasks.manage", "orders.request")
      ? [{ key: "bitrix", label: "Сделки Битрикс24", children: <BitrixDeals /> }]
      : []),
    ...(hasPerm(user, "fg.ship", "fg.invoices")
      ? [{ key: "shipping", label: "Отгрузка", children: <ShipmentsBody /> }]
      : []),
  ];
  return <SectionTabs title="Заказы клиентов" sections={sections} />;
}
