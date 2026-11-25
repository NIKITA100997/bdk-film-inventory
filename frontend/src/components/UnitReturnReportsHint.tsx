import { useQuery } from "@tanstack/react-query";
import { getUnitEvents } from "../api/units";

interface Props {
  unitId: number;
  currentLengthM: number;
  enabled?: boolean;
}

/**
 * Показывает подробный список производственных отчётов с последней выдачи на участок
 * и прогнозный остаток метров прямо над полем ввода фактического остатка при возврате.
 */
export default function UnitReturnReportsHint({ unitId, currentLengthM, enabled = true }: Props) {
  const eventsQuery = useQuery({
    queryKey: ["unit-events", unitId],
    queryFn: () => getUnitEvents(unitId),
    enabled: enabled && unitId > 0,
  });

  const allEvents = eventsQuery.data ?? [];
  const lastIssueIdx = allEvents.findIndex(
    (e) => e.event_type === "Выдача_участку" || e.event_type === "VYDACHA_UCHASTKU",
  );
  const eventsSinceIssue = lastIssueIdx >= 0 ? allEvents.slice(0, lastIssueIdx) : allEvents;
  const reportEvents = eventsSinceIssue.filter((e) => e.event_type === "PRODUCTION_REPORT");

  if (reportEvents.length === 0) return null;

  const usedSinceIssue = reportEvents.reduce((acc, e) => acc + Math.abs(e.quantity_delta_m || 0), 0);
  const forecast = Math.max(0, Number((currentLengthM - usedSinceIssue).toFixed(2)));

  return (
    <div
      style={{
        marginBottom: 12,
        padding: "8px 10px",
        background: "#fffbe6",
        border: "1px solid #ffe58f",
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>Расход по отчётам с последней выдачи ({reportEvents.length}):</span>
        <span>Прогнозный остаток: ~{forecast} м</span>
      </div>
      <div style={{ maxHeight: 130, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
        {reportEvents.map((e) => (
          <div key={e.event_id}>
            <span style={{ color: "var(--bdk-ink-2)" }}>
              {new Date(e.timestamp).toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
              :
            </span>{" "}
            {e.comment ?? `Расход ${Math.abs(e.quantity_delta_m)} м`}
          </div>
        ))}
      </div>
    </div>
  );
}
