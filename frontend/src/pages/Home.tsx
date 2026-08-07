import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { desktopSections, mobileBlocks } from "../layout/navConfig";
import Overview from "./desktop/Overview";
import PageStub from "./PageStub";

function isVisible(item: { roles: string[] }, role: string) {
  return role === "admin" || item.roles.includes(role);
}

export default function Home() {
  const { user } = useAuth();
  if (!user) return null;

  // Обзор (5.5 ТЗ) — десктопная посадочная страница. Если у роли есть доступ
  // хоть к одному десктопному разделу (кроме самого «Обзора»), показываем её
  // прямо на "/"; иначе (роли только со складским/участковым доступом)
  // ведём сразу на первый доступный мобильный экран, как раньше.
  const hasDesktopAccess = desktopSections
    .filter((section) => section.key !== "overview")
    .some((section) => section.items.some((item) => isVisible(item, user.role)));
  if (hasDesktopAccess) return <Overview />;

  const firstMobile = mobileBlocks.flatMap((block) => block.items).find((item) => isVisible(item, user.role));
  if (firstMobile) return <Navigate to={firstMobile.path} replace />;

  return <PageStub title="Добро пожаловать" description="Для вашей роли пока не настроено ни одного экрана." />;
}
