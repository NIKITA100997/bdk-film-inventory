import { useAuth } from "../../auth/AuthContext";
import { hasPerm } from "../../auth/permissions";
import SectionTabs from "../../components/SectionTabs";
import LabelTemplateAdmin from "./LabelTemplateAdmin";
import CalcSettingsAdmin from "./CalcSettingsAdmin";
import CurrencyRatesAdmin from "./CurrencyRatesAdmin";
import BitrixSettings from "./BitrixSettings";
import FilmReserveSettings from "./FilmReserveSettings";
import AreasAndLines from "./AreasAndLines";

/** Настройки системы одним экраном (30.09): параметры расчётов, макет
 * этикетки, валюты и курсы, Битрикс24; с 14.10 — и устройство цеха
 * (площадки, участки, линии) — это настройка, а не ежедневная работа. */
export default function Settings() {
  const { user } = useAuth();
  const sections = [
    ...(hasPerm(user, "users.manage", "production_tasks.manage") ? [{ key: "areas", label: "Участки и линии", children: <AreasAndLines /> }] : []),
    ...(hasPerm(user, "calc_settings.manage") ? [{ key: "calc", label: "Параметры расчётов", children: <CalcSettingsAdmin /> }] : []),
    ...(hasPerm(user, "labels.manage") ? [{ key: "label", label: "Макет этикетки (100×40)", children: <LabelTemplateAdmin /> }] : []),
    ...(hasPerm(user, "prices.manage") ? [{ key: "currencies", label: "Валюты и курсы", children: <CurrencyRatesAdmin /> }] : []),
    ...(hasPerm(user, "users.manage") ? [{ key: "bitrix", label: "Битрикс24", children: <BitrixSettings /> }] : []),
    ...(hasPerm(user, "users.manage") ? [{ key: "film-reserve", label: "Резерв плёнки", children: <FilmReserveSettings /> }] : []),
  ];
  return <SectionTabs title="Настройки" sections={sections} />;
}
