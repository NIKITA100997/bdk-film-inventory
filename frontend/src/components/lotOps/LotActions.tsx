import { useState } from "react";
import { Button, Dropdown, Space, Tooltip } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { useAuth } from "../../auth/AuthContext";
import LotOperationModal from "./LotOperationModal";
import type { MaterialUnit } from "../../api/units";
import type { PartUnit } from "../../api/partUnits";
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

  const modal = open && <LotOperationModal lot={lot} op={open} onClose={() => setOpen(null)} onDone={onDone} />;

  if (layout === "buttons")
    return (
      // окно рисуется порталом, но клики всплывают по дереву React — не отдаём их строке таблицы
      <span onClick={(e) => e.stopPropagation()}>
        <Space size={4} wrap>
          {ops.map(({ op, ok, why }) => (
            <Tooltip key={op} title={ok ? undefined : why}>
              <Button size={size} danger={op === "writeoff"} disabled={!ok} onClick={() => setOpen(op)}>
                {OP_LABEL[op]}
              </Button>
            </Tooltip>
          ))}
        </Space>
        {modal}
      </span>
    );

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Dropdown
        trigger={["click"]}
        menu={{
          items: ops.map(({ op, ok, why }) => ({
            key: op,
            danger: op === "writeoff",
            disabled: !ok,
            label: ok ? OP_LABEL[op] : <span title={why}>{OP_LABEL[op]} — {why?.toLowerCase()}</span>,
          })),
          onClick: ({ key }) => setOpen(key as LotOp),
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
