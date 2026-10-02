"""Точное совпадение остатка на складе под конкретную потребность
(ширина+длина) — вынесено из /units/issue (раздел 2.9 п.1 ТЗ), где эта
проверка была только внутри одного эндпоинта, в переиспользуемый хелпер:
теперь тем же способом пользуется и /units/cutting-plan (раздел про
разбор задания единой таблицей), чтобы потребность, уже закрытая готовым
штрипсом, не попадала в подсказку "резать" наравне с настоящими
нехватками."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.units import MaterialUnit, UnitStatus
from app.services.warehouses import filter_by_warehouse
from app.services.width_analogs import equivalent_widths


def find_exact_stock_match(
    db: Session,
    *,
    material_sku_id: int,
    width_mm: float,
    length_m: float,
    home_warehouse_id: int | None,
    exclude_unit_ids: set[int],
    any_width: bool = False,
) -> MaterialUnit | None:
    """Тот же запрос, что раньше был только в /units/issue: На_хранении,
    та же номенклатура, подходящая ширина, достаточная длина, отфильтровано
    по домашнему складу площадки (когда он задан), самый старый остаток
    первым. exclude_unit_ids — единицы, уже отданные под другую
    потребность в ТОМ ЖЕ вызове (несколько строк с одинаковой шириной не
    должны получить одну и ту же физическую единицу дважды).

    Раздел про аналоги ширин при выдаче — "подходящая ширина" включает не
    только точное совпадение, но и любую ширину из той же вручную заведённой
    группы аналогов (290/285/287мм у "Стоевой" и т.п.); сортировка ставит
    точное совпадение раньше аналога, чтобы аналог расходовался только
    когда точного остатка действительно нет."""
    query = db.query(MaterialUnit).filter(
        MaterialUnit.status == UnitStatus.NA_KHRANENII,
        MaterialUnit.material_sku_id == material_sku_id,
        MaterialUnit.length_m >= length_m,
    )
    # any_width — участок режет плёнку сам (прессы): годится рулон любой
    # ширины не уже детали (width_mm — ширина детали).
    if any_width:
        query = query.filter(MaterialUnit.width_mm >= width_mm)
    else:
        query = query.filter(MaterialUnit.width_mm.in_(equivalent_widths(db, width_mm)))
    if exclude_unit_ids:
        query = query.filter(MaterialUnit.id.notin_(exclude_unit_ids))
    return (
        filter_by_warehouse(query, MaterialUnit.location_code, db, home_warehouse_id)
        .order_by(MaterialUnit.width_mm != width_mm, MaterialUnit.created_at.asc(), MaterialUnit.length_m.asc())
        .first()
    )
