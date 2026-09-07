import type { ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { palette } from "../theme";

/** Компактная кнопка-иконка для колонки "Действия" — подпись только во
 * всплывающей подсказке, чтобы решения умещались в один ряд вместо
 * вертикального стека (раздел про плотную таблицу-очередь, «Выдача
 * участку»/Issue.tsx — вынесено в общий компонент по рекомендации
 * дорожной карты: тот же чертёж подходит под любую очередь работы, не
 * только под плёнку). `onClick`, возвращающий Promise, включает
 * стандартный авто-loading кнопки antd на время выполнения. */
export default function ActionIcon({
  tip,
  onClick,
  tone = "ghost",
  danger,
  children,
}: {
  tip: string;
  onClick?: () => void | Promise<unknown>;
  tone?: "filled" | "outline" | "ghost";
  danger?: boolean;
  children: ReactNode;
}) {
  const style =
    tone === "outline"
      ? { color: palette.orange, borderColor: palette.orange }
      : tone === "ghost"
        ? { color: palette.gray }
        : undefined;
  return (
    <Tooltip title={tip}>
      <Button
        shape="circle"
        size="small"
        type={tone === "filled" ? "primary" : "default"}
        danger={danger}
        onClick={onClick}
        style={style}
        aria-label={tip}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
