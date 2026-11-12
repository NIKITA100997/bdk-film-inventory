import { useMemo, useState } from "react";
import { Button, InputNumber, Select, Space, Tag, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTaskLineReportsBatch } from "../../../../api/production";
import type { MonitorRow } from "../../../../api/productionMonitor";
import { listWriteOffReasons } from "../../../../api/writeOffReasons";
import { apiErrorMessage } from "../../../../utils/apiError";
import { ReportCancelled, sendReportWithConfirm } from "../../../../utils/reportConfirm";
import { newOpKey } from "../../../../utils/opKey";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Быстрый отчёт из монитора (21.10): годные и брак по строке задания —
 * для участков без рулона и дневного плана (склейка, фрезеровка, сборка,
 * кромка, упаковка, п/ф). Тот же отчёт, что у мастера: переспрос сверх
 * плана и повтора, ключ операции от двойного нажатия. compact — в строку
 * таблицы, иначе — столбиком (во всплывающем окне). */
export default function QuickReport({ row, compact = false, onDone }: { row: MonitorRow; compact?: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const left = r2(Math.max(0, row.plan - row.good));
  const [good, setGood] = useState<number | null>(null);
  const [defect, setDefect] = useState<number | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [opKey, setOpKey] = useState(newOpKey);
  const rq = useQuery({ queryKey: ["write-off-reasons", "production"], queryFn: () => listWriteOffReasons("production"), staleTime: 300_000 });
  const reasons = useMemo(() => (rq.data ?? []).filter((r) => r.is_active !== false), [rq.data]);
  const save = useMutation({
    mutationFn: () =>
      sendReportWithConfirm((confirmed) =>
        createTaskLineReportsBatch(
          row.task_id,
          row.task_line_id,
          [{ assignment_id: null, good_pieces: good ?? 0, defect_pieces: defect ?? 0, defect_reason: (defect ?? 0) > 0 ? reason : undefined, confirmed }],
          opKey,
        ),
      ),
    onSuccess: () => {
      message.success(`Отчёт сохранён: ${good ?? 0} годных${defect ? `, брак ${defect}` : ""}`);
      setGood(null);
      setDefect(null);
      setReason(undefined);
      setOpKey(newOpKey()); // следующий отчёт — новая операция
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Отчёт не сохранён"));
    },
  });
  const valid = ((good ?? 0) > 0 || (defect ?? 0) > 0) && (!(defect ?? 0) || !!reason);
  const fields = (
    <>
      <InputNumber
        size="small"
        min={0}
        placeholder={left ? `годных (ост. ${left})` : "годных"}
        value={good}
        onChange={setGood}
        style={{ width: compact ? 120 : 170 }}
        aria-label="Годных, шт"
        onPressEnter={() => valid && save.mutate()}
      />
      <InputNumber size="small" min={0} placeholder="брак" value={defect} onChange={setDefect} style={{ width: 80 }} aria-label="Брак, шт" />
      {(defect ?? 0) > 0 && (
        <Select
          size="small"
          placeholder="причина брака"
          style={{ width: 180 }}
          value={reason}
          onChange={setReason}
          options={reasons.map((r) => ({ value: r.code, label: r.name }))}
          showSearch
          optionFilterProp="label"
        />
      )}
      <Button size="small" type="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
        {compact ? "✓" : "Сохранить"}
      </Button>
    </>
  );
  if (compact) return <Space size={4} wrap>{fields}</Space>;
  return (
    <Space orientation="vertical" size={6} style={{ minWidth: 280, maxWidth: 380 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-word" }}>{row.position}</div>
        {(row.series || row.size || row.color || row.invoice_no) && (
          <div style={{ fontSize: 11, color: "#8c8c8c", marginTop: 2 }}>
            {[row.invoice_no ? `Счёт ${row.invoice_no}` : null, row.series, row.size, row.color].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12 }}>
        <span style={{ color: "#595959" }}>{row.operation ?? "Операция"}:</span>{" "}
        <b>{r2(row.good)}</b> из {r2(row.plan)} шт.
        {left <= 0 ? (
          <Tag color="green" style={{ marginLeft: 6 }}>✓ закрыто</Tag>
        ) : (
          <span style={{ color: "#cf1322", marginLeft: 6 }}>осталось {left} шт.</span>
        )}
        {row.defect > 0 && <span style={{ color: "#ff4d4f", marginLeft: 4 }}>брак {r2(row.defect)}</span>}
      </div>
      <Space size={4} wrap>
        {fields}
      </Space>
      {left > 0 && (
        <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setGood(left)}>
          всё оставшееся — {left} шт
        </Button>
      )}
    </Space>
  );
}
