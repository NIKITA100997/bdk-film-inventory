import type { NavigateFunction } from "react-router-dom";

/** Общая логика поиска "ID единицы или материал" — используется и в
 * глобальной строке в шапке (AppLayout.tsx), и в быстром действии на
 * "Обзоре" для ролей без других сигналов (Overview.tsx, 9.7/10 разделы
 * бэклога доработок). Число — трактуем как ID единицы и сразу открываем
 * карточку единицы, минуя список; текст — уходим на "Остатки" с этим
 * запросом (MaterialsExplorer сам подхватывает location.state.globalQuery). */
export function runUnitOrMaterialSearch(query: string, navigate: NavigateFunction): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  if (/^\d+$/.test(trimmed)) {
    navigate("/m/unit-card", { state: { unitId: Number(trimmed) } });
  } else {
    navigate("/stock", { state: { globalQuery: trimmed } });
  }
}
