"""История цен и сроков поставщика — агрегат по закрытым заявкам снабженцу
с проставленным поставщиком. Фактический срок поставки отдельным полем не
хранится — считается как closed_at - created_at у самой заявки;
promised_delivery_date (план) — отдельное поле на заявке, сравнивается с
closed_at здесь же. Чистая функция агрегации вынесена отдельно от
эндпоинта (доступ к БД) для юнит-тестов, тот же паттерн, что и
services/purchasing.py::requests_closed_by_receipt."""

from dataclasses import dataclass
from datetime import date, datetime

from app.schemas.suppliers import SupplierStatsOut


@dataclass(frozen=True)
class ClosedRequestRecord:
    supplier_id: int
    supplier_name: str
    price_per_m2: float | None
    created_at: datetime
    closed_at: datetime | None
    promised_delivery_date: date | None = None


def compute_supplier_stats(records: list[ClosedRequestRecord]) -> list[SupplierStatsOut]:
    by_supplier: dict[int, list[ClosedRequestRecord]] = {}
    for r in records:
        by_supplier.setdefault(r.supplier_id, []).append(r)

    out: list[SupplierStatsOut] = []
    for supplier_id, recs in by_supplier.items():
        prices = [r.price_per_m2 for r in recs if r.price_per_m2 is not None]
        lead_times = [(r.closed_at - r.created_at).days for r in recs if r.closed_at is not None]
        variances = [
            (r.closed_at.date() - r.promised_delivery_date).days
            for r in recs
            if r.closed_at is not None and r.promised_delivery_date is not None
        ]
        out.append(
            SupplierStatsOut(
                supplier_id=supplier_id,
                supplier_name=recs[0].supplier_name,
                closed_requests=len(recs),
                avg_price_per_m2=round(sum(prices) / len(prices), 2) if prices else None,
                avg_lead_time_days=round(sum(lead_times) / len(lead_times), 1) if lead_times else None,
                avg_delivery_variance_days=round(sum(variances) / len(variances), 1) if variances else None,
                last_request_at=max(r.created_at for r in recs),
            )
        )
    out.sort(key=lambda s: s.last_request_at, reverse=True)
    return out
