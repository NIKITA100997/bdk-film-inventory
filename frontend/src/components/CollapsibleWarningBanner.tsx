import { useState } from "react";
import { Card } from "antd";

/** Раздел про переработку карточек "Без места"/"Без адреса" (плёнка и
 * п/ф) — раньше это была вечно развёрнутая ярко-красная карточка,
 * занимавшая место на экране при каждом заходе, даже если ситуацию уже
 * приняли к сведению. Тон приглушён (тёплый янтарный, не тревожный
 * красный), заголовок с числом остаётся видимым всегда — сворачивается
 * только список строк, состояние — per-браузер (localStorage), не
 * решение системы. */
export default function CollapsibleWarningBanner({
  storageKey,
  count,
  label,
  children,
}: {
  storageKey: string;
  count: number;
  label: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`warning-banner-collapsed:${storageKey}`) === "1";
    } catch {
      return false;
    }
  });

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(`warning-banner-collapsed:${storageKey}`, next ? "1" : "0");
    } catch {
      // приватный режим/запрет на storage — просто не запомнится между заходами
    }
  };

  return (
    <Card
      size="small"
      style={{ background: "#FBF3E7", borderColor: "#E8C99A" }}
      title={`⚠️ ${label}: ${count}`}
      extra={
        <a onClick={toggle} style={{ fontSize: 12.5 }}>
          {collapsed ? "показать ▾" : "скрыть ▴"}
        </a>
      }
    >
      {!collapsed && children}
    </Card>
  );
}
