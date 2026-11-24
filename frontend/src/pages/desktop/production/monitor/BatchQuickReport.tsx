import { useMemo, useState } from "react";
import { Alert, Button, InputNumber, Segmented, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createTaskLineReportsBatch } from "../../../../api/production";
import type { MonitorRow } from "../../../../api/productionMonitor";
import { listWriteOffReasons } from "../../../../api/writeOffReasons";
import { apiErrorMessage } from "../../../../utils/apiError";
import { ReportCancelled, sendReportWithConfirm } from "../../../../utils/reportConfirm";
import { newOpKey } from "../../../../utils/opKey";
import QuickReport from "./QuickReport";

const r2 = (v: number) => Math.round(v * 100) / 100;

interface ParamGroup {
  key: string;
  title: string;
  subtitle: string;
  rows: MonitorRow[];
  plan: number;
  good: number;
  left: number;
}

function getParamKey(r: MonitorRow): { title: string; subtitle: string; key: string } {
  // 1. Ламинация / прессы / окутка — группировка по декору плёнки и размеру
  if (r.film || r.color_name || /ламинац|окутк|пресс/i.test(r.operation || "")) {
    const decor = r.film || [r.color_name, r.mat_name].filter(Boolean).join(" ") || r.color || "Без плёнки";
    const size = [r.height_mm, r.width_mm, r.thickness_mm].every(Boolean)
      ? `${r.thickness_mm}х${r.width_mm}х${r.height_mm} мм`
      : r.size || "";
    return {
      title: decor,
      subtitle: [size, r.position].filter(Boolean).join(" · "),
      key: `lam|${decor}|${size}`,
    };
  }
  // 2. Фрезеровка — по программе / модели и размеру
  if (/фрезер/i.test(r.operation || "")) {
    const prog = r.program || r.series || "Стандартная фрезеровка";
    const size = r.size || [r.height_mm, r.width_mm].filter(Boolean).join("х") || "";
    return {
      title: `Программа: ${prog}`,
      subtitle: [size, r.position].filter(Boolean).join(" · "),
      key: `frz|${prog}|${size}`,
    };
  }
  // 3. Распил — по материалу, толщине и размеру
  if (/распил/i.test(r.operation || "")) {
    const mat = [r.mat_name, r.thickness_mm ? `${r.thickness_mm}мм` : null].filter(Boolean).join(" ") || "МДФ";
    const size = r.size || [r.height_mm, r.width_mm].filter(Boolean).join("х") || "";
    return {
      title: `${mat} ${size}`.trim(),
      subtitle: r.position,
      key: `cut|${mat}|${size}`,
    };
  }
  // 4. По умолчанию — по серии / размеру / цвету
  const desc = [r.series, r.size, r.color].filter(Boolean).join(" · ") || r.position;
  return {
    title: desc,
    subtitle: r.invoice_no ? `Счёт ${r.invoice_no}` : "",
    key: `def|${desc}`,
  };
}

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
  const [showGroups, setShowGroups] = useState(false);
  const [groupInputs, setGroupInputs] = useState<Record<string, { good: number | null; defect: number | null; reason?: string }>>({});
  const [filterTab, setFilterTab] = useState<"all" | "open" | "done">("all");

  const doneRows = useMemo(() => rows.filter((r) => r.closed || r.good >= r.plan), [rows]);
  const displayedRows = useMemo(() => {
    if (filterTab === "open") return openRows;
    if (filterTab === "done") return doneRows;
    return rows;
  }, [rows, openRows, doneRows, filterTab]);

  const rq = useQuery({
    queryKey: ["write-off-reasons", "production"],
    queryFn: () => listWriteOffReasons("production"),
    staleTime: 300_000,
  });
  const reasons = useMemo(() => (rq.data ?? []).filter((r) => r.is_active !== false), [rq.data]);

  // Группировка строк по ключевым производственным параметрам участка
  const groups: ParamGroup[] = useMemo(() => {
    const map = new Map<string, ParamGroup>();
    for (const r of rows) {
      const p = getParamKey(r);
      let g = map.get(p.key);
      if (!g) {
        g = { key: p.key, title: p.title, subtitle: p.subtitle, rows: [], plan: 0, good: 0, left: 0 };
        map.set(p.key, g);
      }
      g.rows.push(r);
      g.plan += r.plan;
      const done = r.closed ? r.plan : Math.min(r.good, r.plan);
      g.good += done;
      g.left += Math.max(0, r.plan - done);
    }
    return [...map.values()].map((g) => ({
      ...g,
      plan: r2(g.plan),
      good: r2(g.good),
      left: r2(g.left),
    }));
  }, [rows]);

  const sendBatch = async (targets: MonitorRow[], gQty: number, dQty: number, dReason?: string) => {
    let remGood = gQty;
    let remDefect = dQty;
    const activeTargets = targets.filter((r) => !r.closed && r.plan - r.good > 0);
    const pool = activeTargets.length > 0 ? activeTargets : targets;

    for (const r of pool) {
      if (remGood <= 0 && remDefect <= 0) break;
      const lineLeft = Math.max(0, r.plan - r.good);
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
                defect_reason: d > 0 ? dReason : undefined,
                confirmed,
              },
            ],
            opKey,
          ),
        );
      }
    }

    if (remGood > 0 || remDefect > 0) {
      const lastRow = pool[pool.length - 1];
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
                defect_reason: remDefect > 0 ? dReason : undefined,
                confirmed,
              },
            ],
            opKey,
          ),
        );
      }
    }
  };

  const saveTotal = useMutation({
    mutationFn: async () => {
      await sendBatch(openRows.length > 0 ? openRows : rows, good ?? 0, defect ?? 0, reason);
    },
    onSuccess: () => {
      message.success(`Отчёт сохранён: ${good ?? 0} годных${defect ? `, брак ${defect}` : ""}`);
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

  const saveGroup = useMutation({
    mutationFn: async (gKey: string) => {
      const g = groups.find((grp) => grp.key === gKey);
      if (!g) return;
      const inp = groupInputs[gKey] || {};
      const gGood = inp.good ?? 0;
      const gDefect = inp.defect ?? 0;
      await sendBatch(g.rows, gGood, gDefect, inp.reason || reason);
    },
    onSuccess: (_, gKey) => {
      message.success("Отчёт по параметру успешно сохранён");
      const nextInputs = { ...groupInputs };
      delete nextInputs[gKey];
      setGroupInputs(nextInputs);
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      // Если больше ничего не заполнено, закрываем форму
      const remainingFilled = Object.values(nextInputs).filter((v) => (v.good ?? 0) > 0 || (v.defect ?? 0) > 0);
      if (remainingFilled.length === 0) {
        onDone?.();
      }
    },
    onError: (e) => {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Отчёт не сохранён"));
    },
  });

  // Заполненные группы и подсчет сумм для массовой сдачи одной кнопкой
  const filledGroups = useMemo(() => {
    return groups.filter((g) => {
      const inp = groupInputs[g.key];
      return (inp?.good ?? 0) > 0 || (inp?.defect ?? 0) > 0;
    });
  }, [groups, groupInputs]);

  const totalFilledGood = useMemo(() => {
    return r2(filledGroups.reduce((s, g) => s + (groupInputs[g.key]?.good ?? 0), 0));
  }, [filledGroups, groupInputs]);

  const totalFilledDefect = useMemo(() => {
    return r2(filledGroups.reduce((s, g) => s + (groupInputs[g.key]?.defect ?? 0), 0));
  }, [filledGroups, groupInputs]);

  const isFilledValid = useMemo(() => {
    if (filledGroups.length === 0) return false;
    return filledGroups.every((g) => {
      const inp = groupInputs[g.key] || {};
      const d = inp.defect ?? 0;
      if (d > 0 && !inp.reason && !reason) return false;
      return true;
    });
  }, [filledGroups, groupInputs, reason]);

  const saveAllGroups = useMutation({
    mutationFn: async () => {
      for (const g of filledGroups) {
        const inp = groupInputs[g.key] || {};
        const gGood = inp.good ?? 0;
        const gDefect = inp.defect ?? 0;
        if (gGood > 0 || gDefect > 0) {
          await sendBatch(g.rows, gGood, gDefect, inp.reason || reason);
        }
      }
    },
    onSuccess: () => {
      message.success(
        `Сдано по ${filledGroups.length} группам: ${totalFilledGood} годных${totalFilledDefect ? `, брак: ${totalFilledDefect}` : ""}`
      );
      setGroupInputs({});
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ReportCancelled) return;
      message.error(apiErrorMessage(e, "Отчёт по группам не сохранён"));
    },
  });

  if (rows.length === 1) {
    return <QuickReport row={rows[0]} onDone={onDone} />;
  }

  const validTotal = ((good ?? 0) > 0 || (defect ?? 0) > 0) && (!(defect ?? 0) || !!reason);

  return (
    <Space orientation="vertical" size={8} style={{ minWidth: 320, maxWidth: 460 }}>
      <div>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {title ?? rows[0]?.operation ?? "Операция"}
        </Typography.Text>
        <div style={{ fontSize: 12, color: "#595959", marginTop: 2 }}>
          План: <b>{totalPlan}</b> шт · Сдано: <b>{totalGood}</b> шт · Осталось:{" "}
          <span style={{ color: totalLeft > 0 ? "#cf1322" : "#389e0d", fontWeight: 600 }}>{totalLeft} шт</span>
        </div>
      </div>

      {/* Список конкретных позиций: что сдано и что осталось */}
      <div style={{ border: "1px solid #e8e8e8", borderRadius: 6, padding: "8px 10px", background: "#ffffff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 6, flexWrap: "wrap" }}>
          <Typography.Text strong style={{ fontSize: 12 }}>
            Позиции в задании ({rows.length}):
          </Typography.Text>
          <Segmented
            size="small"
            value={filterTab}
            onChange={(v) => setFilterTab(v as "all" | "open" | "done")}
            options={[
              { label: `Все (${rows.length})`, value: "all" },
              { label: `В работе (${openRows.length})`, value: "open" },
              { label: `Сдано (${doneRows.length})`, value: "done" },
            ]}
          />
        </div>

        <div style={{ maxHeight: 200, overflowY: "auto", display: "grid", gap: 4 }}>
          {displayedRows.length === 0 ? (
            <div style={{ fontSize: 11, color: "#8c8c8c", padding: "8px 0", textAlign: "center" }}>
              {filterTab === "done" ? "Пока ничего не сдано" : "Все позиции полностью выполнены!"}
            </div>
          ) : (
            displayedRows.map((r) => {
              const isDone = r.closed || r.good >= r.plan;
              const isPart = !isDone && r.good > 0;
              const rem = r2(Math.max(0, r.plan - r.good));
              const sub = [r.invoice_no ? `Счёт ${r.invoice_no}` : null, r.series, r.size, r.color].filter(Boolean).join(" · ");
              return (
                <div
                  key={r.task_line_id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "4px 8px",
                    background: isDone ? "#f6ffed" : isPart ? "#fffbe6" : "#fafafa",
                    border: `1px solid ${isDone ? "#b7eb8f" : isPart ? "#ffe58f" : "#f0f0f0"}`,
                    borderRadius: 4,
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: isDone ? "#237804" : undefined,
                      }}
                      title={r.position}
                    >
                      {r.position}
                    </div>
                    {sub && <div style={{ fontSize: 10, color: "#8c8c8c" }}>{sub}</div>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <Tag
                      color={isDone ? "green" : isPart ? "orange" : "default"}
                      style={{ margin: 0, fontSize: 11, fontVariantNumeric: "tabular-nums" }}
                    >
                      {isDone ? `✓ Сдано ${r2(r.good)}/${r2(r.plan)}` : `${r2(r.good)}/${r2(r.plan)} (ост. ${rem})`}
                    </Tag>
                    {!isDone && (
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: "0 2px", fontSize: 11 }}
                        title={`Заполнить остаток ${rem} шт в поле отчёта`}
                        onClick={() => setGood(rem)}
                      >
                        +{rem}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Быстрое внесение всей суммы */}
      {totalLeft <= 0 ? (
        <Alert type="success" showIcon message="Все позиции этой операции полностью выполнены!" style={{ fontSize: 12 }} />
      ) : (
        <div style={{ background: "#f5f5f5", padding: "8px 10px", borderRadius: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>
            Общий отчёт по открытым строкам:
          </Typography.Text>
          <Space size={6} wrap>
            <InputNumber
              size="small"
              min={0}
              placeholder={totalLeft > 0 ? `всего годных (ост. ${totalLeft})` : "годных"}
              value={good}
              onChange={setGood}
              style={{ width: 170 }}
              aria-label="Годных всего, шт"
              onPressEnter={() => validTotal && saveTotal.mutate()}
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
            <div style={{ marginTop: 6 }}>
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
            </div>
          )}

          <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Button
              size="small"
              type="primary"
              disabled={!validTotal}
              loading={saveTotal.isPending}
              onClick={() => saveTotal.mutate()}
            >
              Сохранить всё ({good ?? 0} шт)
            </Button>
            {totalLeft > 0 && (
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setGood(totalLeft)}>
                сдать всё ({totalLeft} шт)
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Разделение по принципиально важным параметрам для участка */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 4 }}>
        <Button
          size="small"
          type="text"
          style={{ padding: 0, fontSize: 12, color: "#1890ff", fontWeight: 500 }}
          onClick={() => setShowGroups(!showGroups)}
        >
          {showGroups ? "▲ Скрыть параметры участка" : `▼ Разбить по параметрам участка (${groups.length} групп)`}
        </Button>

        {showGroups && (
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {/* Панель массовой сдачи по параметрам участка */}
            <div
              style={{
                background: filledGroups.length > 0 ? "#e6f7ff" : "#fafafa",
                border: `1px solid ${filledGroups.length > 0 ? "#91d5ff" : "#e8e8e8"}`,
                borderRadius: 6,
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <div style={{ fontSize: 12 }}>
                  <b>Сдача по параметрам:</b>{" "}
                  {filledGroups.length > 0 ? (
                    <span style={{ color: "#096dd9" }}>
                      заполнено {filledGroups.length} из {groups.length} групп ({totalFilledGood} годн.
                      {totalFilledDefect ? `, брак: ${totalFilledDefect}` : ""})
                    </span>
                  ) : (
                    <span style={{ color: "#8c8c8c" }}>введите количества в нужные группы ниже</span>
                  )}
                </div>
                <Space size={6}>
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: 0, fontSize: 11 }}
                    onClick={() => {
                      const allLeft: Record<string, { good: number | null; defect: number | null }> = {};
                      for (const g of groups) {
                        if (g.left > 0) {
                          allLeft[g.key] = { good: g.left, defect: null };
                        }
                      }
                      setGroupInputs(allLeft);
                    }}
                  >
                    все остатки
                  </Button>
                  {filledGroups.length > 0 && (
                    <Button
                      size="small"
                      type="link"
                      danger
                      style={{ padding: 0, fontSize: 11 }}
                      onClick={() => setGroupInputs({})}
                    >
                      очистить
                    </Button>
                  )}
                </Space>
              </div>

              <Button
                size="middle"
                type="primary"
                disabled={!isFilledValid}
                loading={saveAllGroups.isPending}
                onClick={() => saveAllGroups.mutate()}
                style={{
                  width: "100%",
                  fontWeight: 600,
                }}
              >
                {filledGroups.length > 0
                  ? `Сдать все заполненные (${filledGroups.length} групп · ${totalFilledGood} шт)`
                  : "Сдать все заполненные группы"}
              </Button>
            </div>

            <div style={{ maxHeight: 320, overflowY: "auto", display: "grid", gap: 6, paddingRight: 2 }}>
              {groups.map((g) => {
                const inp = groupInputs[g.key] || {};
                const isGroupFilled = (inp.good ?? 0) > 0 || (inp.defect ?? 0) > 0;
                const gValid = isGroupFilled && (!(inp.defect ?? 0) || !!inp.reason || !!reason);
                return (
                  <div
                    key={g.key}
                    style={{
                      background: isGroupFilled ? "#f0f9ff" : "#fafafa",
                      border: `1px solid ${isGroupFilled ? "#91d5ff" : "#e8e8e8"}`,
                      borderRadius: 6,
                      padding: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 12 }}>{g.title}</span>
                      <Tag color={g.left > 0 ? "orange" : "green"} style={{ margin: 0, fontSize: 11 }}>
                        {g.good} / {g.plan} (ост. {g.left})
                      </Tag>
                    </div>
                    {g.subtitle && (
                      <Typography.Text type="secondary" style={{ fontSize: 11, display: "block", marginBottom: 6 }}>
                        {g.subtitle}
                      </Typography.Text>
                    )}

                    <Space size={6} wrap style={{ marginTop: 4 }}>
                      <InputNumber
                        size="small"
                        min={0}
                        placeholder={g.left > 0 ? `годно (ост. ${g.left})` : "годно"}
                        value={inp.good}
                        onChange={(v) =>
                          setGroupInputs((prev) => ({
                            ...prev,
                            [g.key]: { ...(prev[g.key] || {}), good: v },
                          }))
                        }
                        style={{ width: 140 }}
                      />
                      <InputNumber
                        size="small"
                        min={0}
                        placeholder="брак"
                        value={inp.defect}
                        onChange={(v) =>
                          setGroupInputs((prev) => ({
                            ...prev,
                            [g.key]: { ...(prev[g.key] || {}), defect: v },
                          }))
                        }
                        style={{ width: 70 }}
                      />
                      <Button
                        size="small"
                        type="default"
                        disabled={!gValid}
                        loading={saveGroup.isPending}
                        onClick={() => saveGroup.mutate(g.key)}
                      >
                        Сдать
                      </Button>
                      {g.left > 0 && (
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0, fontSize: 11 }}
                          onClick={() =>
                            setGroupInputs((prev) => ({
                              ...prev,
                              [g.key]: { ...(prev[g.key] || {}), good: g.left },
                            }))
                          }
                        >
                          все {g.left}
                        </Button>
                      )}
                    </Space>

                    {(inp.defect ?? 0) > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <Select
                          size="small"
                          placeholder="причина брака для этой группы"
                          style={{ width: "100%" }}
                          value={inp.reason || reason}
                          onChange={(v) =>
                            setGroupInputs((prev) => ({
                              ...prev,
                              [g.key]: { ...(prev[g.key] || {}), reason: v },
                            }))
                          }
                          options={reasons.map((r) => ({ value: r.code, label: r.name }))}
                          showSearch
                          optionFilterProp="label"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {groups.length > 3 && (
                <Button
                  size="middle"
                  type="primary"
                  disabled={!isFilledValid}
                  loading={saveAllGroups.isPending}
                  onClick={() => saveAllGroups.mutate()}
                  style={{ width: "100%", marginTop: 4, fontWeight: 600 }}
                >
                  {filledGroups.length > 0
                    ? `Сдать все заполненные (${filledGroups.length} групп · ${totalFilledGood} шт)`
                    : "Сдать все заполненные группы"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Space>
  );
}
