import type { NavigateFunction } from "react-router-dom";
import { Button, Modal, Space, Typography, message } from "antd";
import { apiClient } from "../api/client";
import { listRacks } from "../api/storage";
import { listPartRacks } from "../api/partStorage";

interface IdHit {
  kind: "film_unit" | "part_unit" | "task" | "order";
  id: number;
  title: string;
  subtitle: string | null;
}

const HIT_PATH: Record<IdHit["kind"], (id: number) => [string, unknown?]> = {
  film_unit: (id) => ["/m/unit-card", { unitId: id }],
  part_unit: (id) => ["/m/part-unit-card", { unitId: id }],
  task: (id) => [`/production-tasks?task=${id}`],
  order: (id) => [`/production-orders?order=${id}`],
};

function openHit(hit: IdHit, navigate: NavigateFunction) {
  const [path, state] = HIT_PATH[hit.kind](hit.id);
  navigate(path, state ? { state } : undefined);
}

/** Сквозной поиск по номеру: рулон/штрипс, партия п/ф, задание цеха, заказ.
 * Одно совпадение — открываем сразу, несколько — выбор, ни одного — сообщение. */
async function searchById(n: number, navigate: NavigateFunction): Promise<void> {
  const hits = await apiClient
    .get<IdHit[]>(`/search/by-id/${n}`)
    .then((r) => r.data)
    .catch(() => null);
  if (hits === null) {
    // Сервер недоступен (офлайн-режим склада) — как раньше: номер = рулон.
    navigate("/m/unit-card", { state: { unitId: n } });
    return;
  }
  if (hits.length === 0) {
    message.warning(`По номеру ${n} ничего не найдено`);
    return;
  }
  if (hits.length === 1) {
    openHit(hits[0], navigate);
    return;
  }
  const modal = Modal.info({
    title: `Номер ${n} — что открыть?`,
    icon: null,
    okText: "Отмена",
    content: (
      <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
        {hits.map((h) => (
          <Button
            key={`${h.kind}-${h.id}`}
            block
            style={{ height: "auto", textAlign: "left", whiteSpace: "normal", padding: "8px 12px", justifyContent: "flex-start" }}
            onClick={() => {
              modal.destroy();
              openHit(h, navigate);
            }}
          >
            <Space direction="vertical" size={0}>
              <span>{h.title}</span>
              {h.subtitle && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {h.subtitle}
                </Typography.Text>
              )}
            </Space>
          </Button>
        ))}
      </Space>
    ),
  });
}

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
export async function runUnitOrMaterialSearch(
  query: string,
  navigate: NavigateFunction,
  mode: "search" | "scan" = "search",
): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  // Число. Скан — строго рулон (на бирке рулона голое число, склад не
  // должен спотыкаться о выбор). Ручной ввод — сквозной поиск по всем
  // номерам: рулон, партия п/ф, задание, заказ («№123» — тоже).
  const numberMatch = trimmed.match(/^№?\s*(\d+)$/);
  if (numberMatch) {
    if (mode === "scan") navigate("/m/unit-card", { state: { unitId: Number(numberMatch[1]) } });
    else await searchById(Number(numberMatch[1]), navigate);
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
  // Стеллажи п/ф — по любому коду (не только «ЗГ-…»): коды стеллажей
  // уникальны для плёнки и п/ф (места хранения, этап 5), адрес однозначен.
  const partRacks = await listPartRacks().catch(() => []);
  const pfShelfMatch = trimmed.match(/^(.+)-(\d{2})$/);
  if (pfShelfMatch) {
    const rack = partRacks.find((r) => r.code.toLowerCase() === pfShelfMatch[1].toLowerCase());
    if (rack) {
      navigate("/part-storage", { state: { rackId: rack.id, highlightShelf: Number(pfShelfMatch[2]) } });
      return;
    }
  }
  const pfRack = partRacks.find((r) => r.code.toLowerCase() === trimmed.toLowerCase());
  if (pfRack) {
    navigate("/part-storage", { state: { rackId: pfRack.id } });
    return;
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
