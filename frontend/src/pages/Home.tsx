import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { getEffectiveUxMode, type UxMode } from "../utils/uxMode";
import ModularHome from "./home/ModularHome";
import TerminalHome from "./home/TerminalHome";

export default function Home() {
  const { user } = useAuth();
  const [mode, setMode] = useState<UxMode>(() => getEffectiveUxMode(user));

  useEffect(() => {
    setMode(getEffectiveUxMode(user));
  }, [user]);

  useEffect(() => {
    const onChange = () => setMode(getEffectiveUxMode(user));
    window.addEventListener("bdk-ux-mode-change", onChange);
    return () => window.removeEventListener("bdk-ux-mode-change", onChange);
  }, [user]);

  return mode === "terminal" ? <TerminalHome /> : <ModularHome />;
}
