import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import SectionTabs from "../../components/SectionTabs";
import ActionRequests from "./ActionRequests";
import DeletionRequests from "./DeletionRequests";

/** Запросы (14.10) — одним пунктом вместо двух: запросы сотрудников
 * (любое действие, в котором отказали) и заявки на удаление. */
export default function Requests() {
  const { user } = useAuth();
  const sections = [
    { key: "actions", label: "Запросы сотрудников", children: <ActionRequests /> },
    ...(hasPerm(user, "users.manage") ? [{ key: "deletions", label: "Заявки на удаление", children: <DeletionRequests /> }] : []),
  ];
  return <SectionTabs title="Запросы" sections={sections} />;
}
