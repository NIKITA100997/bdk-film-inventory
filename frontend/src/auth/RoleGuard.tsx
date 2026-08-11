import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spin, message } from "antd";
import { useAuth } from "./AuthContext";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spin fullscreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// permissions не задан (или пуст) — экран виден любому аутентифицированному
// пользователю (раньше это была роль-константа ALL_ROLES); иначе видимость —
// по любому совпадению права из списка (8.3 раздел бэклога доработок,
// замена RequireRole/roles: UserRole[]).
export function RequirePermission({ permissions, children }: { permissions?: string[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const denied =
    !loading &&
    !!user &&
    !user.is_superuser &&
    !!permissions?.length &&
    !permissions.some((p) => user.permissions.includes(p));

  // 9.3 раздел бэклога доработок — раньше редирект на "/" был тихим,
  // пользователь просто оказывался в другом месте без объяснений.
  useEffect(() => {
    if (denied) message.warning("У вас нет доступа к этому разделу");
  }, [denied]);

  if (loading) return <Spin fullscreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (denied) return <Navigate to="/" replace />;
  return <>{children}</>;
}
