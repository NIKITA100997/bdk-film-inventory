import type { ReactNode } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import type { PageFormat } from "../api/partLabels";
import ActionIcon from "./ActionIcon";

/** Кнопка печати с выбором формата страницы (раздел про печать этикеток
 * п/ф в формате А4) — обычная наклейка или целый лист А4 для крупных
 * объектов (поддон, стеллаж, крупная партия). Прецедента "выбор формата
 * в момент печати" в проекте не было (тумблер "вертикально" в меню
 * профиля — это настройка устройства через localStorage, не подходит
 * по смыслу для решения, зависящего от конкретного объекта печати) —
 * Dropdown с двумя пунктами: не Popconfirm (тот для да/нет, не для
 * выбора из двух именованных вариантов), не Modal (слишком тяжело для
 * одноразового, неразрушающего выбора).
 *
 * variant="icon" — компактная круглая иконка для колонки "Действия"
 * (как ActionIcon), variant="button" (по умолчанию) — обычная кнопка с
 * текстом, для заголовков карточек (см. StorageMap.tsx-подобный ряд
 * кнопок в PartStorage.tsx). */
export default function PrintFormatButton({
  tip,
  onPrint,
  variant = "button",
  children,
}: {
  tip: string;
  onPrint: (format: PageFormat) => void;
  variant?: "icon" | "button";
  children: ReactNode;
}) {
  const menu = {
    items: [
      { key: "sticker", label: "Обычная наклейка" },
      { key: "a4", label: "Лист А4" },
    ],
    onClick: ({ key }: { key: string }) => onPrint(key as PageFormat),
  };

  if (variant === "icon") {
    return (
      <Dropdown menu={menu} trigger={["click"]}>
        <span>
          <ActionIcon tip={tip}>{children}</ActionIcon>
        </span>
      </Dropdown>
    );
  }

  return (
    <Dropdown menu={menu} trigger={["click"]}>
      <Tooltip title={tip}>
        <Button size="small">{children}</Button>
      </Tooltip>
    </Dropdown>
  );
}
