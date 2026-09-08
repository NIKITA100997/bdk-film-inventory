import type { NavigateFunction } from "react-router-dom";
import { listRacks } from "../api/storage";
import { listPartRacks } from "../api/partStorage";

/** Общая логика поиска "ID единицы или материал" — используется и в
 * глобальной строке в шапке (AppLayout.tsx), и в быстром действии на
 * "Обзоре" для ролей без других сигналов (Overview.tsx, 9.7/10 разделы
 * бэклога доработок), и в глобальном сканере QR в шапке. Число — трактуем
 * как ID единицы и сразу открываем карточку единицы, минуя список.
 *
 * QR на бирке стеллажа/полки — тот же формат, что уже разбирает
 * StorageMap.tsx на своей собственной странице ("Р-3" — стеллаж целиком,
 * "Р-3-07" — код стеллажа + номер полки): раньше глобальный сканер в
 * шапке (единственный, доступный с любого экрана, не только со
 * "Стеллажей") про этот формат не знал вообще и отправлял такой скан в
 * поиск по материалу на "Остатках", где он ничего не находил ("QR
 * стеллажа не ведёт на стеллаж"). Здесь та же проверка, просто с
 * переходом на /storage (уже поддерживает rackId/highlightShelf в
 * location.state — раньше только для кросс-ссылки "На стеллаже" из
 * Остатков, теперь и для скана), не дублируя парсинг в StorageMap.tsx.
 *
 * Иначе — уходим на "Остатки" с этим запросом (MaterialsExplorer сам
 * подхватывает location.state.globalQuery). */
export async function runUnitOrMaterialSearch(query: string, navigate: NavigateFunction): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  if (/^\d+$/.test(trimmed)) {
    navigate("/m/unit-card", { state: { unitId: Number(trimmed) } });
    return;
  }

  // Раздел про QR-этикетки п/ф — партия ("ПФ"+id) и стеллаж/полка
  // ("ЗГ-..."), отдельный числовой префикс/пространство кодов от плёнки,
  // чтобы не путать с единицей плёнки (голые цифры) или с её стеллажами
  // (код без префикса "ЗГ-"). Проверяем ДО общего плёночного стеллажного
  // регэкспа ниже — иначе "ЗГ-1-01" совпал бы с ним же (та же форма
  // "код-НН"), но у плёночных стеллажей такого кода нет, и скан молча
  // проваливался бы в поиск по /stock (тот же класс бага, что уже чинили
  // для плёночных стеллажей в этом же сканере).
  const pfUnitMatch = trimmed.match(/^ПФ(\d+)$/i);
  if (pfUnitMatch) {
    navigate("/m/part-unit-card", { state: { unitId: Number(pfUnitMatch[1]) } });
    return;
  }
  if (/^ЗГ-/i.test(trimmed)) {
    const partRacks = await listPartRacks().catch(() => []);
    const pfShelfMatch = trimmed.match(/^(.+)-(\d{2})$/);
    if (pfShelfMatch) {
      const rack = partRacks.find((r) => r.code === pfShelfMatch[1]);
      if (rack) {
        navigate("/part-storage", { state: { rackId: rack.id, highlightShelf: Number(pfShelfMatch[2]) } });
        return;
      }
    }
    const rack = partRacks.find((r) => r.code === trimmed);
    if (rack) {
      navigate("/part-storage", { state: { rackId: rack.id } });
      return;
    }
  }

  const racks = await listRacks().catch(() => []);
  const shelfMatch = trimmed.match(/^(.+)-(\d{2})$/);
  if (shelfMatch) {
    const rack = racks.find((r) => r.code === shelfMatch[1]);
    if (rack) {
      navigate("/storage", { state: { rackId: rack.id, highlightShelf: Number(shelfMatch[2]) } });
      return;
    }
  }
  const rack = racks.find((r) => r.code === trimmed);
  if (rack) {
    navigate("/storage", { state: { rackId: rack.id } });
    return;
  }

  navigate("/stock", { state: { globalQuery: trimmed } });
}
