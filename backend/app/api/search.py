"""Сквозной поиск по номеру (строка поиска в шапке): число — это может быть
рулон/штрипс плёнки, партия п/ф, задание цеха или заказ на производство.
Отдаём все совпадения — одно открывается сразу, несколько — на выбор.
Видно только то, на что у пользователя есть права (как на самих экранах)."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.items import sku_item_name
from app.models.part_units import PartUnit
from app.models.production import ProductionTask
from app.models.production_orders import ProductionOrder
from app.models.units import MaterialUnit
from app.models.users import User

router = APIRouter(tags=["search"])


class IdHit(BaseModel):
    kind: str  # film_unit / part_unit / task / order
    id: int
    title: str
    subtitle: str | None = None


@router.get("/search/by-id/{number}", response_model=list[IdHit])
def search_by_id(number: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[IdHit]:
    perms = get_permission_codes(user)
    can = lambda *codes: user.is_superuser or bool(perms & set(codes))  # noqa: E731
    hits: list[IdHit] = []
    unit = db.get(MaterialUnit, number)
    if unit is not None:
        sku = unit.material_sku
        hits.append(
            IdHit(
                kind="film_unit", id=unit.id,
                title=f"{'Штрипс' if unit.is_strip else 'Рулон'} №{unit.id}: "
                + sku_item_name(sku.material.name, sku.color.name, sku.thickness.value_mm, sku.manufacturer.name),
                subtitle=f"{float(unit.width_mm):g} мм × {float(unit.length_m):g} м · {unit.status.value.replace('_', ' ')}"
                + (f" · {unit.location_code}" if unit.location_code else ""),
            )
        )
    if can("part_units.view", "part_units.manage"):
        lot = db.get(PartUnit, number)
        if lot is not None:
            hits.append(
                IdHit(
                    kind="part_unit", id=lot.id, title=f"Партия п/ф №{lot.id}: {lot.part.name}",
                    subtitle=f"{float(lot.quantity_pieces):g} шт · {lot.stage.name if lot.stage else ''} · "
                    f"{lot.status.value.replace('_', ' ')}" + (f" · {lot.location_code}" if lot.location_code else ""),
                )
            )
    if can("production_tasks.manage", "production_tasks.view", "production_tasks.report"):
        task = db.get(ProductionTask, number)
        if task is not None:
            name = task.name or (task.product_model.name if task.product_model else None) or "без названия"
            hits.append(
                IdHit(
                    kind="task", id=task.id, title=f"Задание цеха №{task.id}: {name}",
                    subtitle=("активно" if task.is_active else "в архиве") + f" · строк: {len(task.lines)}",
                )
            )
        order = db.get(ProductionOrder, number)
        if order is not None:
            status = {"draft": "черновик", "released": "запущен", "closed": "закрыт"}.get(order.status, order.status)
            hits.append(
                IdHit(kind="order", id=order.id, title=f"Заказ на производство №{order.id}: {order.name}", subtitle=status)
            )
    return hits
