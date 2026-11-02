"""Сервис аналитики брака и проведения планёрок по качеству (Парето 80/20).

Чистая бизнес-логика:
- Парето-ранжирование причин брака (накопительный процент, Зона А);
- Антирейтинг оборудования и технологических линий;
- Антирейтинг декоров и плёнок (проблемные цвета);
- Оценка финансового ущерба от брака (рубли);
- Формирование управленческих выводов и рекомендаций для совещания.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date


DEFAULT_ESTIMATED_PART_COST_RUB = 350.0  # Оценочная себестоимость детали ПФ при отсутствии точной калькуляции


@dataclass
class ParetoReasonItem:
    reason_code: str
    reason_name: str
    defect_pieces: float
    cost_rub: float
    share_percent: float
    cumulative_percent: float
    is_zone_a: bool


@dataclass
class MachineDefectItem:
    line_id: int | None
    line_name: str
    area: str | None
    area_name: str | None
    defect_pieces: float
    good_pieces: float
    defect_rate_percent: float
    top_reason: str | None
    cost_rub: float


@dataclass
class DecorDefectItem:
    color_id: int | None
    color_name: str
    defect_pieces: float
    good_pieces: float
    defect_rate_percent: float
    top_reason: str | None


@dataclass
class QualityMeetingReport:
    date_from: date
    date_to: date
    area: str | None
    total_defect_pieces: float
    total_good_pieces: float
    total_defect_rate_percent: float
    total_loss_rub: float
    total_film_wasted_m: float
    pareto_reasons: list[ParetoReasonItem]
    machine_ranking: list[MachineDefectItem]
    decor_ranking: list[DecorDefectItem]
    zone_a_summary: str
    recommended_actions: list[str] = field(default_factory=list)


def generate_recommendations(top_reasons: list[str]) -> list[str]:
    """Генерация рекомендаций для планерки начальника цеха на основе топ-причин."""
    actions: list[str] = []
    seen = set()
    for r in top_reasons:
        low = r.lower()
        if any(w in low for w in ("пузыр", "непроклей", "отслоен")) and "glue" not in seen:
            actions.append("Проверить температуру клеевой ванны и прижим роликов на линии окутки.")
            seen.add("glue")
        elif any(w in low for w in ("скол", "торец", "вырыв", "задир")) and "saw" not in seen:
            actions.append("Проверить заточку пильных дисков и фрез, проконтролировать скорость подачи заготовок.")
            seen.add("saw")
        elif any(w in low for w in ("залом", "складк", "натяжен")) and "tension" not in seen:
            actions.append("Проверить соосность направляющих и натяжение плёнки на узле размотки.")
            seen.add("tension")
        elif any(w in low for w in ("разнотон", "пятн", "глянец", "шагрень", "сырь")) and "film_qc" not in seen:
            actions.append("Выполнить входной контроль рулонов партии поставщика на соответствие эталонному вееру.")
            seen.add("film_qc")
        elif any(w in low for w in ("геометр", "размер", "кривизн", "перекос")) and "geo" not in seen:
            actions.append("Проверить калибровку упоров и линейных направляющих распиловочного центра.")
            seen.add("geo")

    if not actions:
        actions.append("Провести внеплановый инструктаж операторов смены и проверить рабочие параметры оборудования.")
    return actions


def compute_quality_meeting(
    raw_reports: list[dict],
    date_from: date,
    date_to: date,
    area: str | None = None,
) -> QualityMeetingReport:
    """Чистый расчет аналитики для планёрки по качеству."""
    total_defects = sum(float(r.get("defect_pieces") or 0.0) for r in raw_reports)
    total_good = sum(float(r.get("good_pieces") or 0.0) for r in raw_reports)
    total_rate = round((total_defects / total_good * 100), 2) if total_good > 0 else 0.0

    total_loss_rub = 0.0
    total_film_wasted_m = 0.0

    # 1. Агрегация по причинам дефектов
    reasons_pieces: dict[str, float] = defaultdict(float)
    reasons_cost: dict[str, float] = defaultdict(float)
    reasons_names: dict[str, str] = {}

    # 2. Агрегация по оборудованию (линиям)
    line_defects: dict[int | None, float] = defaultdict(float)
    line_good: dict[int | None, float] = defaultdict(float)
    line_costs: dict[int | None, float] = defaultdict(float)
    line_info: dict[int | None, tuple[str, str | None, str | None]] = {}
    line_reason_counts: dict[int | None, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    # 3. Агрегация по декорам (цветам)
    color_defects: dict[int | None, float] = defaultdict(float)
    color_good: dict[int | None, float] = defaultdict(float)
    color_names: dict[int | None, str] = {}
    color_reason_counts: dict[int | None, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for r in raw_reports:
        defects = float(r.get("defect_pieces") or 0.0)
        good = float(r.get("good_pieces") or 0.0)
        cost = float(r.get("cost_rub") or 0.0)
        film_m = float(r.get("film_used_m") or 0.0)

        # Оценка прямых потерь от брака
        if defects > 0:
            if cost > 0 and (good + defects) > 0:
                report_loss = round(cost * (defects / (good + defects)), 2)
            else:
                report_loss = round(defects * DEFAULT_ESTIMATED_PART_COST_RUB, 2)
            total_loss_rub += report_loss

            if film_m > 0 and (good + defects) > 0:
                total_film_wasted_m += round(film_m * (defects / (good + defects)), 2)

            rcode = str(r.get("reason_code") or "OTHER")
            rname = str(r.get("reason_name") or rcode or "Без указания причины")
            reasons_names[rcode] = rname
            reasons_pieces[rcode] += defects
            reasons_cost[rcode] += report_loss

            lid = r.get("line_id")
            line_reason_counts[lid][rname] += defects

            cid = r.get("color_id")
            cname = str(r.get("color_name") or "Не указан")
            color_reason_counts[cid][rname] += defects
        else:
            report_loss = 0.0

        # Линия
        lid = r.get("line_id")
        lname = str(r.get("line_name") or "Общий участок (без линии)")
        acode = r.get("area_code")
        aname = r.get("area_name")
        line_info[lid] = (lname, acode, aname)
        line_defects[lid] += defects
        line_good[lid] += good
        line_costs[lid] += report_loss

        # Декор
        cid = r.get("color_id")
        cname = str(r.get("color_name") or "Без декора / сырая")
        color_names[cid] = cname
        color_defects[cid] += defects
        color_good[cid] += good

    # Построение Парето-ряда причин
    pareto_reasons: list[ParetoReasonItem] = []
    if total_defects > 0:
        sorted_reasons = sorted(reasons_pieces.items(), key=lambda x: -x[1])
        acc_pieces = 0.0
        for rcode, pieces in sorted_reasons:
            share = round((pieces / total_defects) * 100, 1)
            # В Зону А входят причины, пока накопленный объем не превысил 80%
            is_zone_a = (acc_pieces / total_defects) < 0.8
            acc_pieces += pieces
            cum_percent = round((acc_pieces / total_defects) * 100, 1)
            pareto_reasons.append(
                ParetoReasonItem(
                    reason_code=rcode,
                    reason_name=reasons_names.get(rcode, rcode),
                    defect_pieces=round(pieces, 2),
                    cost_rub=round(reasons_cost[rcode], 2),
                    share_percent=share,
                    cumulative_percent=min(100.0, cum_percent),
                    is_zone_a=is_zone_a,
                )
            )

    # Управленческий вывод по Зоне А
    zone_a_items = [p for p in pareto_reasons if p.is_zone_a]
    if zone_a_items:
        zone_a_share = round(sum(p.share_percent for p in zone_a_items), 1)
        top_names = ", ".join(f"«{p.reason_name}» ({p.share_percent}%)" for p in zone_a_items[:3])
        zone_a_summary = (
            f"По правилу Парето (80/20), {zone_a_share}% всех потерь вызваны {len(zone_a_items)} ключевыми причинами: "
            f"{top_names}. Концентрация усилий на их устранении устранит подавляющую часть издержек."
        )
    elif total_defects > 0:
        zone_a_summary = "Брак распределён равномерно по редким причинам. Рекомендуется точечный разбор отчётов."
    else:
        zone_a_summary = "За выбранный период брак на производстве отсутствует. Все линии работают в штатном режиме!"

    top_reason_names = [p.reason_name for p in pareto_reasons[:4]]
    recommended_actions = generate_recommendations(top_reason_names) if total_defects > 0 else []

    # Рейтинг линий (станков)
    machine_ranking: list[MachineDefectItem] = []
    for lid, d_pieces in sorted(line_defects.items(), key=lambda x: -x[1]):
        if d_pieces <= 0 and line_good[lid] <= 0:
            continue
        lname, acode, aname = line_info.get(lid, ("Линия", None, None))
        g_pieces = line_good[lid]
        d_rate = round((d_pieces / g_pieces * 100), 2) if g_pieces > 0 else (100.0 if d_pieces > 0 else 0.0)
        reasons_map = line_reason_counts[lid]
        top_r = max(reasons_map.items(), key=lambda x: x[1])[0] if reasons_map else None
        machine_ranking.append(
            MachineDefectItem(
                line_id=lid,
                line_name=lname,
                area=acode,
                area_name=aname,
                defect_pieces=round(d_pieces, 2),
                good_pieces=round(g_pieces, 2),
                defect_rate_percent=d_rate,
                top_reason=top_r,
                cost_rub=round(line_costs[lid], 2),
            )
        )

    # Рейтинг декоров (цветов)
    decor_ranking: list[DecorDefectItem] = []
    for cid, d_pieces in sorted(color_defects.items(), key=lambda x: -x[1]):
        if d_pieces <= 0 and color_good[cid] <= 0:
            continue
        cname = color_names.get(cid, "Не указан")
        g_pieces = color_good[cid]
        d_rate = round((d_pieces / g_pieces * 100), 2) if g_pieces > 0 else (100.0 if d_pieces > 0 else 0.0)
        reasons_map = color_reason_counts[cid]
        top_r = max(reasons_map.items(), key=lambda x: x[1])[0] if reasons_map else None
        decor_ranking.append(
            DecorDefectItem(
                color_id=cid,
                color_name=cname,
                defect_pieces=round(d_pieces, 2),
                good_pieces=round(g_pieces, 2),
                defect_rate_percent=d_rate,
                top_reason=top_r,
            )
        )

    return QualityMeetingReport(
        date_from=date_from,
        date_to=date_to,
        area=area,
        total_defect_pieces=round(total_defects, 2),
        total_good_pieces=round(total_good, 2),
        total_defect_rate_percent=total_rate,
        total_loss_rub=round(total_loss_rub, 2),
        total_film_wasted_m=round(total_film_wasted_m, 2),
        pareto_reasons=pareto_reasons,
        machine_ranking=machine_ranking,
        decor_ranking=decor_ranking[:12],  # топ-12 проблемных декоров
        zone_a_summary=zone_a_summary,
        recommended_actions=recommended_actions,
    )

