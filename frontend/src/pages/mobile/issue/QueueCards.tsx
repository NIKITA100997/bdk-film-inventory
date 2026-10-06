import { type ReactNode } from "react";
import {
  Button,
  Card,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  printLabel,
  printLabelsBatch,
  skuLabel,
} from "../../../api/units";
import { rollNo } from "../../../utils/lotNo";
import { type NeedTableRow, type ManualTableRow, findSku, neededLengthM } from "./model";
import { AcceptReturnButton } from "./ReturnActions";
import { type IssueState } from "./useIssue";

/** Очередь «Выдачи участку» карточками (06.10: из Issue.tsx). */
export default function QueueCards({ s }: { s: IssueState }) {
  const { canReturn, canIssue, canManage, search, cardTab, cardGroup, setSlipModalOpen, setSlipTaskId, decidedLineIds, lineInfoMap, setManualPickerTarget, skusQuery, areaLabel, homeWarehouseFor, closeLineMutation, issuedNoteForLine, lineActuals, UnitLink, tableRows, groupRowsByRowKey, openDetail, whenLabel, inCardTab, acceptRow, readyRow } = s;
  const cardLine = (row: NeedTableRow, showTask: boolean) => {
    const info = lineInfoMap.get(row.line.id);
    const issuedNote = issuedNoteForLine(row.line);
    const decided = decidedLineIds.has(row.line.id);
    const when = whenLabel(row);
    const groupRows = groupRowsByRowKey.get(row.key);
    const sku = findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness);
    const need = row.assignment ? `${row.assignment.quantity_pieces} шт · ${neededLengthM(row).toFixed(1)} м` : `${row.line.shortfall_length_m} м`;
    let state: ReactNode = null;
    let action: ReactNode = null;
    if (issuedNote) {
      const { stillOut } = lineActuals(row.line);
      state = <Tag color="green">{issuedNote}{stillOut > 0 ? ` · к сдаче ${stillOut} м` : ""}</Tag>;
      action = (
        <Space size={4} wrap>
          {row.line.issued_units.length > 0 && (
            <Button onClick={() => printLabelsBatch(row.line.issued_units.map((u) => u.id), { kind: "cutting_issue" })}>🖨</Button>
          )}
          {canReturn && row.line.issued_units.map((u) => <AcceptReturnButton key={u.id} unit={u} />)}
          {canManage && (
            <Button loading={closeLineMutation.isPending} onClick={() => closeLineMutation.mutate({ taskId: row.task.id, lineId: row.line.id, isClosed: true })}>
              Закрыть
            </Button>
          )}
        </Space>
      );
    } else if (decided) {
      state = <Tag color="processing">🕒 в решениях</Tag>;
    } else if (info?.status.kind === "stock") {
      state = (
        <Tag color="green" title={info.status.match.shared ? "Один штрипс на несколько деталей — выдаётся один раз" : undefined}>
          ✅ штрипс {rollNo(info.status.match.unit_id)}
          {info.status.match.shared ? " · общий" : ""}
          {(() => {
            const home = homeWarehouseFor(row.task.area);
            return home && home.name !== "Основной склад" ? ` · есть на «${home.name}»` : "";
          })()}
        </Tag>
      );
      if (canIssue && info.acceptStock)
        action = (
          <Button type="primary" size="large" style={{ background: "#1D8F68" }} onClick={info.acceptStock}>
            Выдать {rollNo(info.status.match.unit_id)}
          </Button>
        );
    } else if (info?.status.kind === "cut_planned") {
      state = <Tag color="gold">✂ резать из {rollNo(info.donorUnitId)}</Tag>;
      if (canIssue && info.acceptCut)
        action = (
          <Button type="primary" size="large" onClick={() => void info.acceptCut!()}>
            В резку
          </Button>
        );
    } else if (info?.status.kind === "no_donor") {
      const home = homeWarehouseFor(row.task.area);
      state = (
        <Tag color="red">
          {home && home.name !== "Основной склад" ? `✖ на складе «${home.name}» нет — переместить` : "✖ нет донора"}
        </Tag>
      );
      if (canIssue && groupRows && sku)
        action = (
          <Button size="large" onClick={() => setManualPickerTarget({ sku, rows: groupRows })}>
            Подобрать…
          </Button>
        );
    }
    return (
      <div
        key={row.key}
        style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid rgba(0,0,0,.06)", alignItems: "center", flexWrap: "wrap" }}
      >
        <div style={{ minWidth: 220, flex: 1 }}>
          <Typography.Text strong>{row.line.part_name ?? "Деталь без названия"}</Typography.Text>
          <div style={{ fontSize: 13, color: "#6E6A61" }}>
            {showTask
              ? `${row.task.product_model_name ?? row.task.name ?? `Задание №${row.task.id}`} · `
              : `${row.line.material}, ${row.line.color}, ${row.line.thickness} мм · штрипс ${row.line.strip_width_mm || row.line.width_mm} мм · `}
            {issuedNote ? `выдано ${row.line.issued_length_m} м` : `нужно ${need}`}
            {row.assignment ? ` · ${row.assignment.line_name}` : ""}
          </div>
        </div>
        <Space size={6} wrap style={{ justifyContent: "flex-end" }}>
          <Tag color={when.color} style={{ marginInlineEnd: 0 }}>{when.text}</Tag>
          {state}
          {action}
          <Button type="text" onClick={() => openDetail(row)} aria-label="Подробнее">
            ⋯
          </Button>
        </Space>
      </div>
    );
  };

    const rows = tableRows.filter(inCardTab);
    const need = rows.filter((r): r is NeedTableRow => r.kind === "need");
    const manual = rows.filter((r): r is ManualTableRow => r.kind === "manual");
    const groups = new Map<string, { title: ReactNode; area: string; rows: NeedTableRow[]; taskId?: number }>();
    for (const r of need) {
      const key =
        cardGroup === "task"
          ? `t${r.task.id}`
          : `f${r.task.area}|${r.line.material}|${r.line.color}|${r.line.thickness}|${r.line.strip_width_mm || r.line.width_mm}`;
      if (!groups.has(key))
        groups.set(key, {
          area: r.task.area,
          taskId: cardGroup === "task" ? r.task.id : undefined,
          title:
            cardGroup === "task" ? (
              <>
                {r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}`}
                <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                  {" "}
                  · №{r.task.id}
                </Typography.Text>
              </>
            ) : (
              <>
                {r.line.material}, {r.line.color}, {r.line.thickness} мм
                <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                  {" "}
                  · штрипс {r.line.strip_width_mm || r.line.width_mm} мм
                </Typography.Text>
              </>
            ),
          rows: [],
        });
      groups.get(key)!.rows.push(r);
    }
    const byArea = new Map<string, typeof groups extends Map<string, infer V> ? V[] : never>();
    for (const g of groups.values()) byArea.set(g.area, [...(byArea.get(g.area) ?? []), g]);
    if (!groups.size && !manual.length)
      return (
        <Typography.Paragraph type="secondary" style={{ textAlign: "center", padding: 32 }}>
          {search.trim() ? "Ничего не нашлось — проверьте вкладки «Решено» и «Выдано»" : "Здесь пусто"}
        </Typography.Paragraph>
      );
    return (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {[...byArea.entries()].map(([area, list]) => (
          <div key={area}>
            <Typography.Text type="secondary" style={{ fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 700 }}>
              {areaLabel(area)}
            </Typography.Text>
            <Space direction="vertical" size="middle" style={{ width: "100%", marginTop: 6 }}>
              {list.map((g, gi) => {
                const ready = g.rows.filter(readyRow);
                const totalM = g.rows.reduce((sum, r) => sum + (issuedNoteForLine(r.line) ? 0 : neededLengthM(r)), 0);
                return (
                  <Card key={gi} size="small" styles={{ body: { padding: 0 } }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "12px 14px", flexWrap: "wrap", alignItems: "center" }}>
                      <div>
                        <Typography.Text strong style={{ fontSize: 16 }}>
                          {g.title}
                        </Typography.Text>
                        <div style={{ fontSize: 13, color: "#6E6A61" }}>
                          {g.rows.length} {g.rows.length === 1 ? "деталь" : g.rows.length < 5 ? "детали" : "деталей"}
                          {totalM > 0 ? ` · нужно ${Math.round(totalM * 10) / 10} м` : ""}
                        </div>
                      </div>
                      <Space wrap>
                        {canIssue && cardTab === "need" && ready.length > 0 && (
                          <Button type="primary" size="large" style={{ background: "#1D8F68" }} onClick={() => ready.forEach(acceptRow)}>
                            Всё готовое ({ready.length} из {g.rows.length})
                          </Button>
                        )}
                        {g.taskId != null && (
                          <Button
                            onClick={() => {
                              setSlipTaskId(g.taskId);
                              setSlipModalOpen(true);
                            }}
                          >
                            📋 Лист
                          </Button>
                        )}
                      </Space>
                    </div>
                    {g.rows.map((r) => cardLine(r, cardGroup === "film"))}
                  </Card>
                );
              })}
            </Space>
          </div>
        ))}
        {manual.length > 0 && (
          <Card size="small" title="✋ Выдано без задания">
            {manual.map((r) => (
              <div key={r.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", flexWrap: "wrap" }}>
                <span>
                  <UnitLink id={r.unit.id} /> · {skuLabel(r.unit.material_sku)} · {r.unit.width_mm} мм × {r.unit.length_m} м ·{" "}
                  {r.unit.area ? areaLabel(r.unit.area) : "—"}
                </span>
                <Space size={4}>
                  <Button onClick={() => printLabel(r.unit.id, { kind: "cutting_issue" })}>🖨</Button>
                  {canReturn && (
                    <AcceptReturnButton
                      unit={{
                        id: r.unit.id,
                        width_mm: r.unit.width_mm,
                        length_m: r.unit.length_m,
                        material_sku_id: r.unit.material_sku.id,
                        parent_id: r.unit.parent_id,
                        is_strip: r.unit.is_strip,
                        status: r.unit.status,
                        area: r.unit.area,
                      }}
                    />
                  )}
                </Space>
              </div>
            ))}
          </Card>
        )}
      </Space>
    );

}
