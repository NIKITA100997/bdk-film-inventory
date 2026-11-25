import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";

/** Подписка на Server-Sent Events (SSE) для мгновенного обновления остатков,
 * заданий и уведомлений на планшетах и десктопе без частого polling. */
export function useRealtimeSync(enabled: boolean): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const token = localStorage.getItem("access_token");
    if (!token) return;

    const base = (apiClient.defaults.baseURL || "/api").replace(/\/+$/, "");
    const url = `${base}/realtime/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    const onUnits = () => {
      qc.invalidateQueries({ queryKey: ["units"] });
      qc.invalidateQueries({ queryKey: ["unit-reconciliation"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["factoryPulse"] });
    };
    const onPartUnits = () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["factoryPulse"] });
    };
    const onTasks = () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["factoryPulse"] });
    };
    const onApprovals = () => {
      qc.invalidateQueries({ queryKey: ["action-requests-summary"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
    };

    es.addEventListener("units", onUnits);
    es.addEventListener("part_units", onPartUnits);
    es.addEventListener("tasks", onTasks);
    es.addEventListener("approvals", onApprovals);

    return () => {
      es.close();
    };
  }, [enabled, qc]);
}
