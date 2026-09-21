import { useNavigate } from "react-router-dom";

/** Раздел про недостающие кликабельные ссылки в отчётах/журнале действий
 * (полный аудит приложения) — номер единицы/партии там был просто
 * текстом, хотя тот же переход "открыть карточку по id" уже реализован
 * в нескольких других местах (мобильная "Выдача" — UnitLink,
 * "Карточка единицы"/"Карточка партии" сами открываются именно так по
 * приходу state.unitId). Общий компонент вместо копипасты одного и того
 * же onClick в каждом отчёте. */
export function UnitLink({ id }: { id: number }) {
  const navigate = useNavigate();
  return <a onClick={() => navigate("/m/unit-card", { state: { unitId: id } })}>№{id}</a>;
}

export function PartUnitLink({ id }: { id: number }) {
  const navigate = useNavigate();
  return <a onClick={() => navigate("/m/part-unit-card", { state: { unitId: id } })}>№{id}</a>;
}
