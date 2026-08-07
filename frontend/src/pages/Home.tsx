import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { allNav } from "../layout/navConfig";
import PageStub from "./PageStub";

export default function Home() {
  const { user } = useAuth();
  if (!user) return null;

  const first = allNav.find((item) => user.role === "admin" || item.roles.includes(user.role));
  if (first) return <Navigate to={first.path} replace />;

  return <PageStub title="Добро пожаловать" description="Для вашей роли пока не настроено ни одного экрана." />;
}
