import { useMemo, useState } from "react";
import { Button, InputNumber, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTaskLineReportsBatch } from "../../../../api/production";
import type { MonitorRow } from "../../../../api/productionMonitor";
import { listWriteOffReasons } from "../../../../api/writeOffReasons";
import { apiErrorMessage } from "../../../../utils/apiError";
import { ReportCancelled, sendReportWithConfirm } from "../../../../utils/reportConfirm";
import { newOpKey } from "../../../../utils/opKey";
import QuickReport from "./QuickReport";

const r2 = (v: number) => Math.round(v * 100) / 100;

export default function BatchQuickReport({
  rows,
  title,
  onDone,
}: {
  rows: MonitorRow[];
  title?: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const openRows = useMemo(() => rows.filter((r) => !r.closed && r.plan - r.good > 0), [rows]);
  const totalPlan = r2(rows.reduce((s, r) => s + r.plan, 0));
  const totalGood = r2(rows.reduce((s, r) => s + (r.closed ? r.plan : Math.min(r.good, r.plan)), 0));
  const totalLeft = r2(Math.max(0, totalPlan - totalGood));

  const [good, setGood] = useState<number | null>(null);
  const [defect, setDefect] = useState<number | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [showDetails, setShowDetails] = useState(false);

  const rq = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
    staleTime: 300_000,
  });
  const reasons = useMemo(() => (rq.data ?? []).filter((r) => r.is_active !== false), [rq.data]);

  const save = useMutation({
    mutationFn: async () => {
      let remGood = good ?? 0;
      let remDefect = defect ?? 0;

      // Раскладываем общее количество последовательно по строкам с дефицитом
      const targets = openRows.length > 0 ? openRows : rows;
      for (const r of targets) {
        if (remGood <= 0 && remDefect <= 0) break;
        const lineLeft = Math.max(0, r.plan - r.good);
        // Если есть остаток по строке, отдаем в нее; если всё заполнено, остаток отдаем в последнюю строку
        const g = lineLeft > 0 ? Math.min(remGood, lineLeft) : remGood;
        const d = lineLeft > 0 ? Math.min(remDefect, lineLeft - g) : remDefect;

        remGood -= g;
        remDefect -= d;

        if (g > 0 || d > 0) {
          const opKey = newOpKey();
          await sendReportWithConfirm((confirmed) =>
            createTaskLineReportsBatch(
              r.task_id,
              r.task_line_id,
              [
                {
                  assignment_id: null,
                  good_pieces: g,
                  defect_pieces: d,
                  defect_reason: d > 0 ? reason : undefined,
                  confirmed,
                },
              ],
              opKey,
            ),
          );
        }
      }

      // Если после закрытия планов остался излишек сверх плана, пишем в последнюю строку
      if (remGood > 0 || remDefect > 0) {
        const lastRow = targets[targets.length - 1];
        if (lastRow) {
          const opKey = newOpKey();
          await sendReportWithConfirm((confirmed) =>
            createTaskLineReportsBatch(
              lastRow.task_id,
              lastRow.task_line_id,
              [
                {
                  assignment_id: null,
                  good_pieces: remGood,
                  defect_pieces: remDefect,
                  defect_reason: remDefect > 0 ? reason : undefined,
                  confirmed,
                },
              ],
              opKey,
            ),
          );
        }
      }
    },
    onSuccess: () => {
      message.success(`Отчёт по группе сохранён: ${good ?? 0} годных${defect ? `, брак ${defect}` : ""}`);
      setGood(null);
      setDefect(null);
      setReason(undefined);
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Отчёт не сохранён"));
    },
  });

  if (rows.length === 1) {
    return <QuickReport row={rows[0]} onDone={onDone} />;
  }

  const valid = ((good ?? 0) > 0 || (defect ?? 0) > 0) && (!(defect ?? 0) || !!reason);

  return (
    <Space orientation="vertical" size={6} style={{ minWidth: 280, maxWidth: 360 }}>
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {title ?? rows[0]?.operation ?? "Операция"} (всего: {rows.length} строк)
        </Typography.Text>
        <div style={{ fontSize: 12, color: "#8c8c8c" }}>
          План: {totalPlan} шт · Сделано: {totalGood} шт · Осталось: <b>{totalLeft} шт</b>
        </div>
      </div>

      <Space size={4} wrap>
        <InputNumber
          size="small"
          min={0}
          placeholder={totalLeft > 0 ? `всего годных (ост. ${totalLeft})` : "годных"}
          value={good}
          onChange={setGood}
          style={{ width: 170 }}
          aria-label="Годных всего, шт"
          onPressEnter={() => valid && save.mutate()}
        />
        <InputNumber
          size="small"
          min={0}
          placeholder="брак"
          value={defect}
          onChange={setDefect}
          style={{ width: 80 }}
          aria-label="Брак всего, шт"
        />
      </Space>

      {(defect ?? 0) > 0 && (
        <Select
          size="small"
          placeholder="причина брака"
          style={{ width: "100%" }}
          value={reason}
          onChange={setReason}
          options={reasons.map((r) => ({ value: r.code, label: r.name }))}
          showSearch
          optionFilterProp="label"
        />
      )}

      <Space size={6} wrap style={{ marginTop: 2 }}>
        <Button
          size="small"
          type="primary"
          disabled={!valid}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Сохранить всё ({good ?? 0} шт)
        </Button>
        {totalLeft > 0 && (
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setGood(totalLeft)}>
            сдать всё оставшееся ({totalLeft} шт)
          </Button>
        )}
      </Space>

      <div style={{ marginTop: 6, borderTop: "1px dashed #e8e8e8", paddingTop: 4 }}>
        <Button
          size="small"
          type="text"
          style={{ padding: 0, fontSize: 11, color: "#1890ff" }}
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails ? "▲ Скрыть разбивку по счетам" : `▼ Показать по отдельным счетам (${rows.length})`}
        </Button>
        {showDetails && (
          <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 4, display: "grid", gap: 6 }}>
            {rows.map((r) => (
              <div key={r.task_line_id} style={{ background: "#fafafa", padding: 6, borderRadius: 4, fontSize: 11 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span><b>{r.invoice_no || `Задание №${r.task_id}`}</b>: ост. {r2(Math.max(0, r.plan - r.good))} шт</span>
                  <Tag style={{ margin: 0 }}>{r2(r.good)}/{r2(r.plan)}</Tag>
                </div>
                <QuickReport row={r} compact onDone={onDone} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Space>
  );
}
