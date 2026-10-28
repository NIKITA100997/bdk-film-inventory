import type { ReactNode } from "react";
import { Button, Space, Typography } from "antd";
import { ArrowRightOutlined, CheckCircleFilled, ClockCircleOutlined, ExclamationCircleFilled } from "@ant-design/icons";

/** «Что дальше» (28.10): программа сама ведёт по правильному пути — один
 * заметный блок вверху экрана: что сейчас нужно сделать именно вам и кнопка,
 * которая это делает. tone: action — ваш ход; wait — ждём другого;
 * warn — что-то мешает; done — всё сделано. */
export type NextStepTone = "action" | "wait" | "warn" | "done";

const TONE: Record<NextStepTone, { bar: string; bg: string; icon: ReactNode; label: string }> = {
  action: { bar: "#C97A2B", bg: "#FBF0E3", icon: <ArrowRightOutlined style={{ color: "#C97A2B" }} />, label: "Следующий шаг" },
  wait: { bar: "#2F6FB2", bg: "#EAF2FB", icon: <ClockCircleOutlined style={{ color: "#2F6FB2" }} />, label: "Ждём" },
  warn: { bar: "#C0392B", bg: "#FBEAE8", icon: <ExclamationCircleFilled style={{ color: "#C0392B" }} />, label: "Сначала" },
  done: { bar: "#1D9E75", bg: "#E7F5EE", icon: <CheckCircleFilled style={{ color: "#1D9E75" }} />, label: "Готово" },
};

export interface NextStepProps {
  tone: NextStepTone;
  title: ReactNode;
  text?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  loading?: boolean;
  /** что ещё можно сделать — мелкими ссылками */
  extra?: ReactNode;
}

export default function NextStep({ tone, title, text, actionLabel, onAction, loading, extra }: NextStepProps) {
  const t = TONE[tone];
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "10px 16px",
        background: t.bg,
        borderLeft: `5px solid ${t.bar}`,
        borderRadius: 10,
        padding: "12px 16px",
      }}
    >
      <div style={{ fontSize: 22, lineHeight: 1 }}>{t.icon}</div>
      <div style={{ flex: "1 1 280px", minWidth: 0 }}>
        <Typography.Text style={{ fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", color: t.bar, fontWeight: 700 }}>
          {t.label}
        </Typography.Text>
        <div style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.3 }}>{title}</div>
        {text && <div style={{ color: "#4A4D5C", marginTop: 2 }}>{text}</div>}
      </div>
      {(actionLabel || extra) && (
        <Space wrap>
          {extra}
          {actionLabel && onAction && (
            <Button type="primary" size="large" loading={loading} onClick={onAction}>
              {actionLabel}
            </Button>
          )}
        </Space>
      )}
    </div>
  );
}

/** Прокрутить к блоку экрана по id — «кнопка ведёт туда, где это делается». */
export const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
