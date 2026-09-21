import { useState } from "react";
import { Segmented, Space } from "antd";
import MaterialsExplorer from "./MaterialsExplorer";
import StorageMap from "./StorageMap";

/** Раздел про переработку вкладок остатков/стеллажей — «Остатки плёнки»
 * (список по SKU) и «Стеллажи и полки» (карта — где физически лежит) это
 * один и тот же вопрос "что и где", просто два способа посмотреть,
 * поэтому один экран с переключателем вида вместо двух пунктов меню (тот
 * же приём, что уже сделан для п/ф — см. PartInventory.tsx).
 *
 * defaultView — раздел про сканирование "Р-.../СШ..." (unitSearch.ts, см.
 * navigate("/storage", {state})) и переход "Разместить" из самих
 * "Остатков" (MaterialsExplorer.tsx): скан/переход продолжают открывать
 * карту с уже выделенной полкой — маршрут /storage остаётся, просто
 * теперь это тот же экран, открытый сразу на виде "Карта". Переход из
 * меню («Остатки плёнки») открывает вид "Список" по умолчанию.*/
export default function MaterialInventory({ defaultView }: { defaultView: "list" | "map" }) {
  const [view, setView] = useState<"list" | "map">(defaultView);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Segmented
        value={view}
        onChange={(v) => setView(v as "list" | "map")}
        options={[
          { label: "📋 Список (по позиции)", value: "list" },
          { label: "🗄 Карта стеллажей", value: "map" },
        ]}
      />
      {view === "list" ? <MaterialsExplorer /> : <StorageMap />}
    </Space>
  );
}
