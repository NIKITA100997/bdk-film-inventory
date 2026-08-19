"""Раздел про модуль "Брак и списания" — чистые вычисления, вынесенные из
app/api/reports.py, чтобы их можно было протестировать без БД (тот же
принцип, что и у остального проекта, см. app/services/splitting.py)."""

import datetime as dt
from dataclasses import dataclass, field

_NO_REASON_LABEL = "Без причины"


def delta_percent(current: float, previous: float) -> float | None:
    """Изменение к предыдущему периоду той же длины, в процентах — None,
    если в предыдущем периоде данных не было вовсе (иначе пришлось бы
    показывать вводящий в заблуждение "+∞%")."""
    if not previous:
        return None
    return round((current - previous) / previous * 100, 1)


def defect_rate_percent(defect_pieces: float, good_pieces: float) -> float:
    """Доля брака от годных изделий (та же метрика, что уже используется
    на строке задания — remaining_pieces считается от produced_good_pieces
    в app/api/production.py) — 0 при good_pieces == 0, а не деление на ноль."""
    return round(defect_pieces / good_pieces * 100, 1) if good_pieces else 0.0


def bucket_date_range(date_from: dt.date, date_to: dt.date, bucket_days: int = 7) -> list[tuple[dt.date, dt.date]]:
    """Разбивка периода на бакеты по bucket_days дней (раздел "Динамика по
    неделям") — последний бакет короче остальных, если период не делится
    ровно; всегда хотя бы один бакет, даже если период короче bucket_days."""
    if date_from > date_to:
        return []
    buckets: list[tuple[dt.date, dt.date]] = []
    start = date_from
    while start <= date_to:
        end = min(start + dt.timedelta(days=bucket_days - 1), date_to)
        buckets.append((start, end))
        start = end + dt.timedelta(days=1)
    return buckets


@dataclass
class PivotInputRow:
    """Один отчёт о производстве (ProductionTaskLineReport) в разрезе,
    который уже выбран запросом (деталь/участок/линия) — group_key/label
    считает SQL-слой, эта функция только агрегирует."""

    group_key: str
    group_label: str
    parent_label: str | None
    reason_name: str | None
    defect_pieces: float
    good_pieces: float


@dataclass
class PivotGroupRow:
    group_key: str
    group_label: str
    parent_label: str | None
    by_reason: dict[str, float] = field(default_factory=dict)
    defect_pieces: float = 0.0
    good_pieces: float = 0.0
    defect_rate_percent: float = 0.0


@dataclass
class PivotResult:
    reasons: list[str]
    rows: list[PivotGroupRow]
    total: PivotGroupRow


def build_defect_pivot(rows: list[PivotInputRow]) -> PivotResult:
    """Сводная таблица брака на производстве — строки отсортированы по
    убыванию брака (сначала худшие). good_pieces группы считает по КАЖДОЙ
    строке отчёта (даже без брака — иначе доля брака была бы посчитана не
    от всего объёма производства), а причины-столбцы собираются только из
    строк с реальным браком — иначе на любом отчёте без брака (defect_reason
    всегда пуст при defect_pieces == 0) появлялся бы пустой столбец
    "Без причины" из одних нулей."""
    reasons_seen: list[str] = []
    groups: dict[str, PivotGroupRow] = {}
    order: list[str] = []

    for row in rows:
        if row.group_key not in groups:
            groups[row.group_key] = PivotGroupRow(
                group_key=row.group_key, group_label=row.group_label, parent_label=row.parent_label
            )
            order.append(row.group_key)
        group = groups[row.group_key]
        group.good_pieces += row.good_pieces
        if row.defect_pieces > 0:
            reason_label = row.reason_name or _NO_REASON_LABEL
            if reason_label not in reasons_seen:
                reasons_seen.append(reason_label)
            group.by_reason[reason_label] = group.by_reason.get(reason_label, 0.0) + row.defect_pieces
            group.defect_pieces += row.defect_pieces

    group_rows = list(groups[key] for key in order)
    for g in group_rows:
        g.defect_rate_percent = defect_rate_percent(g.defect_pieces, g.good_pieces)
    group_rows.sort(key=lambda g: g.defect_pieces, reverse=True)

    total = PivotGroupRow(group_key="__total__", group_label="Итого", parent_label=None)
    total.defect_pieces = sum(g.defect_pieces for g in group_rows)
    total.good_pieces = sum(g.good_pieces for g in group_rows)
    for reason in reasons_seen:
        total.by_reason[reason] = sum(g.by_reason.get(reason, 0.0) for g in group_rows)
    total.defect_rate_percent = defect_rate_percent(total.defect_pieces, total.good_pieces)

    return PivotResult(reasons=reasons_seen, rows=group_rows, total=total)
