import { useState } from "react";
import { Segmented, Space } from "antd";
import PartStock from "./PartStock";
import PartStorage from "../PartStorage";

/** Раздел про переработку вкладок остатков/стеллажей — «Остатки п/ф»
 * (сводка по детали) и «Стеллажи п/ф» (карта — где физически лежит) это
 * один и тот же вопрос "что и где", просто два способа посмотреть,
 * поэтому один экран с переключателем вида вместо двух пунктов меню.
 *
 * defaultView — раздел про сканирование "ЗГ-..."/"ПФ..." (unitSearch.ts,
 * см. navigate("/part-storage", {state})): скан продолжает открывать
 * карту с уже выделенной полкой, чтобы не ломать сценарий — маршрут
 * /part-storage остаётся, просто теперь это тот же экран, открытый сразу
 * на виде "Карта". Переход из меню («Остатки п/ф») открывает вид
 * "Список" по умолчанию. Сам переключатель не меняет URL — это
 * по-прежнему один экран, а не два разных места в приложении. */
export default function PartInventory({ defaultView }: { defaultView: "list" | "map" }) {
  const [view, setView] = useState<"list" | "map">(defaultView);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Segmented
        value={view}
        onChange={(v) => setView(v as "list" | "map")}
        options={[
          { label: "📋 Список (по детали)", value: "list" },
          { label: "🗄 Карта стеллажей", value: "map" },
        ]}
      />
      {view === "list" ? <PartStock /> : <PartStorage />}
    </Space>
  );
}
