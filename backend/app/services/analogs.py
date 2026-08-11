"""Аналоги позиций номенклатуры и признак неликвида (8 раздел обратной
связи) — привязка ручная (SkuAnalog), но признак «неликвидный остаток» и
текущий остаток по конкретной позиции считаются здесь же, чтобы калькулятор
продажника и админка номенклатуры не дублировали логику."""

import datetime as dt

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.abc import CalcSettings
from app.models.dictionaries import MaterialSku, SkuAnalog
from app.models.units import MaterialUnit, UnitStatus


def sku_stock_m2(db: Session, sku_id: int) -> float:
    """Остаток именно по этой позиции (материал+цвет+толщина+производитель),
    в отличие от current_stock_m2 в dictionaries.py, который суммирует по
    группе без производителя (нужно заявке/плану, не тут)."""
    total = (
        db.query(func.sum(MaterialUnit.width_mm * MaterialUnit.length_m))
        .filter(MaterialUnit.material_sku_id == sku_id, MaterialUnit.status != UnitStatus.SPISAN)
        .scalar()
    )
    return round(float(total or 0) / 1000, 3)


def sku_stale_days(db: Session, sku_id: int, stale_threshold_days: int) -> int | None:
    """Сколько дней самая старая нетронутая единица На_хранении по этой
    позиции уже простаивает, если это больше порога — иначе None (не
    неликвид). Тот же порог, что и в отчёте «Давно не двигались»."""
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=stale_threshold_days)
    oldest_updated = (
        db.query(func.min(MaterialUnit.updated_at))
        .filter(
            MaterialUnit.material_sku_id == sku_id,
            MaterialUnit.status == UnitStatus.NA_KHRANENII,
            MaterialUnit.updated_at < cutoff,
        )
        .scalar()
    )
    if oldest_updated is None:
        return None
    return (dt.datetime.now(dt.timezone.utc) - oldest_updated).days


def list_analog_links(db: Session, sku_id: int) -> list[SkuAnalog]:
    """Связи в обе стороны — привязка ненаправленная по смыслу (см. модель)."""
    return (
        db.query(SkuAnalog)
        .filter((SkuAnalog.sku_id == sku_id) | (SkuAnalog.analog_sku_id == sku_id))
        .all()
    )


def analog_sku_of(link: SkuAnalog, sku_id: int) -> MaterialSku:
    return link.analog_sku if link.sku_id == sku_id else link.sku


def create_analog_link(db: Session, *, sku_id: int, analog_sku_id: int, note: str | None) -> SkuAnalog:
    existing = (
        db.query(SkuAnalog)
        .filter(
            ((SkuAnalog.sku_id == sku_id) & (SkuAnalog.analog_sku_id == analog_sku_id))
            | ((SkuAnalog.sku_id == analog_sku_id) & (SkuAnalog.analog_sku_id == sku_id))
        )
        .first()
    )
    if existing is not None:
        return existing
    link = SkuAnalog(sku_id=sku_id, analog_sku_id=analog_sku_id, note=note)
    db.add(link)
    db.commit()
    db.refresh(link)
    return link


def get_stale_threshold_days(db: Session) -> int:
    settings = db.get(CalcSettings, 1)
    return settings.stale_threshold_days if settings else 60
