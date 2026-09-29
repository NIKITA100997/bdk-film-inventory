import { useState } from "react";
import dayjs from "dayjs";
import { Alert, Button, List, Modal, Space, Typography, message } from "antd";
import { checkPlanMove, type MoveCheck, type MoveCheckIn } from "../../../api/planning";

type Pending = { check: MoveCheck; run: (shiftNext: boolean) => void };

/** Перед переносом в планировщике: не встанет ли этап раньше предыдущего
 * или позже следующего. Конфликт — окно: что задето, что сдвинется, и
 * выбор — сдвинуть следующие этапы, перенести только это или отменить. */
export function useMoveGuard() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = async (payload: MoveCheckIn, run: (shiftNext: boolean) => void) => {
    setBusy(true);
    try {
      const check = await checkPlanMove(payload);
      if (check.conflicts.length === 0) run(false);
      else setPending({ check, run });
    } catch {
      message.error("Не удалось проверить связанные этапы — перенос не выполнен");
    } finally {
      setBusy(false);
    }
  };

  const fmt = (d: string) => dayjs(d).format("DD.MM");
  const next = pending?.check.conflicts.filter((c) => c.relation === "next") ?? [];
  const prev = pending?.check.conflicts.filter((c) => c.relation === "prev") ?? [];

  const modal = pending && (
    <Modal
      open
      width={720}
      title="Перенос задевает связанные этапы"
      onCancel={() => setPending(null)}
      footer={
        <Space wrap>
          <Button onClick={() => setPending(null)}>Отмена</Button>
          <Button
            onClick={() => {
              pending.run(false);
              setPending(null);
            }}
          >
            Перенести только это
          </Button>
          {next.length > 0 && (
            <Button
              type="primary"
              onClick={() => {
                pending.run(true);
                setPending(null);
              }}
            >
              Перенести и сдвинуть следующие этапы
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        {next.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="Следующий этап окажется не позже этого"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {next.map((c, i) => (
                  <li key={i}>
                    {c.operation ?? c.what} ({c.area_name}) стоит на {fmt(c.start)} — нужно не раньше {fmt(c.need)}
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {prev.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="Предыдущий этап ещё не будет сделан"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {prev.map((c, i) => (
                  <li key={i}>
                    {c.operation ?? c.what} ({c.area_name}) заканчивается {fmt(c.start)} — этот этап можно ставить не раньше{" "}
                    следующего рабочего дня. Сначала перенесите предыдущий.
                  </li>
                ))}
              </ul>
            }
          />
        )}
        {pending.check.will_shift.length > 0 && (
          <div>
            <Typography.Text strong>Если сдвинуть следующие этапы:</Typography.Text>
            <List
              size="small"
              dataSource={pending.check.will_shift}
              renderItem={(s) => (
                <List.Item>
                  {s.operation ?? s.what} · {s.area_name}: {fmt(s.before)} → <b>{fmt(s.after)}</b>
                </List.Item>
              )}
            />
          </div>
        )}
      </Space>
    </Modal>
  );

  return { guard, modal, busy };
}
