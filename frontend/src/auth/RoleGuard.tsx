import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Spin, message } from "antd";
import { useAuth } from "./AuthContext";
import type { UserRole } from "./types";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Spin fullscreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function RequireRole({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const denied = !loading && !!user && user.role !== "admin" && !roles.includes(user.role);

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
