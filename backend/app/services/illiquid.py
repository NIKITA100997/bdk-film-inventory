"""Неликвид (23.10) — пометка на рулоне основного цвета, не отдельный цвет.

Обычная строка задания неликвид не берёт (подбор, резерв, донор, «что
резать», свободный остаток); строка «из неликвида» (use_illiquid) — берёт
только его. В «Доступно»/«заказать» неликвид не считается."""

from sqlalchemy.orm import Session

from app.models.units import MaterialUnit


def only(query, illiquid: bool = False):
    """Сузить запрос единиц: illiquid=False — без неликвида, True — только неликвид."""
    return query.filter(MaterialUnit.marked_illiquid.is_(bool(illiquid)))


def line_wants(db: Session, line_id: int | None) -> bool:
    """Строка задания «из неликвида»?"""
    if line_id is None:
        return False
    from app.models.production import ProductionTaskLine

    line = db.get(ProductionTaskLine, line_id)
    return bool(line and line.use_illiquid)
