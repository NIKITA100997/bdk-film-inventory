import { useState } from "react";
import { Button, Dropdown, Space, Tooltip } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { useAuth } from "../../auth/AuthContext";
import LotOperationModal from "./LotOperationModal";
import { printLabel, type MaterialUnit } from "../../api/units";
import type { PartUnit } from "../../api/partUnits";
import { printPartUnitLabel } from "../../api/partLabels";
import { OP_LABEL, lotOps, type LotOp, type LotRef } from "./lotOps";

/** Действия с партией — одна кнопка «Действия ▾» (или ряд кнопок в
 * карточке) для рулона и партии п/ф: что доступно по статусу и правам,
 * недоступное — серым с причиной. Открывает единое окно операции. */
export default function LotActions({
  lot,
  layout = "menu",
  size,
  hideUnavailable = false,
  onDone,
}: {
  lot: LotRef;
  /** menu — «Действия ▾» (строка таблицы); buttons — ряд кнопок (карточка). */
  layout?: "menu" | "buttons";
  size?: "small" | "middle" | "large";
  /** Скрыть недоступные (строки таблиц) вместо серых с причиной (карточки). */
  hideUnavailable?: boolean;
  onDone?: (updated: MaterialUnit | PartUnit) => void;
}) {
  const { user } = useAuth();
  const has = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  const ops = lotOps(lot, has).filter((o) => o.ok || !hideUnavailable);
  const [open, setOpen] = useState<LotOp | null>(null);
  if (ops.length === 0) return null;
  // этикетка — сразу на печать, без окна (14.10: у любой партии в одном меню)
  const canLabel = lot.status.replace(/_/g, " ") !== "Списан";
  const printLot = () => (lot.kind === "plenka" ? printLabel(lot.lot_id) : printPartUnitLabel(lot.lot_id));

  const modal = open && <LotOperationModal lot={lot} op={open} onClose={() => setOpen(null)} onDone={onDone} />;

  if (layout === "buttons")
    return (
      // окно рисуется порталом, но клики всплывают по дереву React — не отдаём их строке таблицы
      <span onClick={(e) => e.stopPropagation()}>
        <Space size={4} wrap>
          {ops.map(({ op, ok, why }) => (
            <Tooltip key={op} title={ok ? undefined : why}>
              <Button size={size} danger={op === "writeoff" || op === "delete"} disabled={!ok} onClick={() => setOpen(op)}>
                {OP_LABEL[op]}
              </Button>
            </Tooltip>
          ))}
          {canLabel && (
            <Button size={size} onClick={printLot}>
              Этикетка
            </Button>
          )}
        </Space>
        {modal}
      </span>
    );

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: [
            ...ops.map(({ op, ok, why }) => ({
              key: op,
              danger: op === "writeoff" || op === "delete",
              disabled: !ok,
              label: ok ? OP_LABEL[op] : <span title={why}>{OP_LABEL[op]} — {why?.toLowerCase()}</span>,
            })),
            ...(canLabel ? [{ type: "divider" as const }, { key: "label", label: "Печать этикетки" }] : []),
          ],
          onClick: ({ key }) => (key === "label" ? printLot() : setOpen(key as LotOp)),
        }}
      >
        <Button size={size ?? "small"}>
          Действия <DownOutlined />
        </Button>
      </Dropdown>
      {modal}
    </span>
  );
}
