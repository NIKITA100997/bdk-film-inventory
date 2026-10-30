"""Волновой маршрутный лист сборки (Pick Route / Wave Picking) для склада.

Оптимизирует обход склада кладовщиком:
1. Группирует открытые потребности участков на смену в единую «волну» сборки.
2. Сортирует ячейки хранения по естественному физическому маршруту (Стеллаж -> Полка), исключая хаотичные перемещения по складу.
3. Поддерживает контроль сканирования QR-кода при снятии рулона со стеллажа для исключения ошибок пересортицы.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.dictionaries import Color, Material, Thickness
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.units import MaterialUnit, UnitStatus


@dataclass
class PickRouteItem:
    pick_id: str
    unit_id: int | None
    location_code: str  # "Р-3-07", "Ш-1-02", "Перемотка-01"
    rack_code: str
    shelf_num: int
    task_id: int
    task_name: str
    task_line_id: int
    target_area: str
    target_area_name: str
    material_name: str
    color_name: str
    thickness_val: float
    width_mm: float
    length_needed_m: float
    unit_length_m: float | None = None
    barcode: str | None = None
    is_verified: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "pick_id": self.pick_id,
            "unit_id": self.unit_id,
            "location_code": self.location_code,
            "rack_code": self.rack_code,
            "shelf_num": self.shelf_num,
            "task_id": self.task_id,
            "task_name": self.task_name,
            "task_line_id": self.task_line_id,
            "target_area": self.target_area,
            "target_area_name": self.target_area_name,
            "decor_name": f"{self.color_name} {self.thickness_val}мм ({self.material_name})",
            "material_name": self.material_name,
            "color_name": self.color_name,
            "width_mm": round(self.width_mm, 1),
            "length_needed_m": round(self.length_needed_m, 2),
            "unit_length_m": round(self.unit_length_m, 2) if self.unit_length_m is not None else None,
            "barcode": self.barcode or (str(self.unit_id) if self.unit_id else None),
            "is_verified": self.is_verified,
        }


@dataclass
class PickRouteWave:
    wave_id: str
    created_at: str
    target_area: str | None
    total_items: int
    total_meters: float
    distinct_racks_count: int
    items: list[PickRouteItem] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "wave_id": self.wave_id,
            "created_at": self.created_at,
            "target_area": self.target_area,
            "total_items": self.total_items,
            "total_meters": round(self.total_meters, 2),
            "distinct_racks_count": self.distinct_racks_count,
            "items": [item.to_dict() for item in self.items],
        }


def _parse_location_key(location_code: str | None) -> tuple[int, str, int, int]:
    """Разбор адреса ячейки (например: 'Р-3-07' -> (0, 'Р', 3, 7)) для сортировки по маршруту обхода.
    0: Адресные стеллажи (Р-1, Р-2, Ш-1)
    1: Зоны подготовки (Перемотка-01)
    2: Не размещённые
    """
    if not location_code:
        return (2, "ZZZ", 999, 999)

    code = location_code.strip()
    # Match patterns like Р-3-07, Ш-1-04
    m = re.match(r"^([РШСRSCршсrsc])[-_]?(\d+)[-_]?(\d+)?", code)
    if m:
        prefix = m.group(1).upper()
        rack_num = int(m.group(2))
        shelf_num = int(m.group(3)) if m.group(3) else 0
        return (0, prefix, rack_num, shelf_num)

    return (1, code, 0, 0)


def generate_pick_route(
    db: Session,
    area: str | None = None,
    limit_lines: int = 40,
) -> PickRouteWave:
    """Генерация сменного маршрутного листа сборщика для склада."""
    # Preload dictionaries
    mat_names = {m.id: m.name for m in db.query(Material).all()}
    col_names = {c.id: c.name for c in db.query(Color).all()}
    th_vals = {t.id: float(t.value_mm) for t in db.query(Thickness).all()}

    # Area names
    from app.models.areas import Area
    area_names = {a.code: a.name for a in db.query(Area).all()}

    # 1. Open lines requiring film issue
    query = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(
            ProductionTask.is_active.is_(True),
            ProductionTaskLine.is_closed.is_(False),
            ProductionTaskLine.material_id.isnot(None),
        )
    )
    if area:
        query = query.filter(ProductionTask.area == area)

    open_lines = query.limit(limit_lines).all()

    pick_items: list[PickRouteItem] = []
    racks_set: set[str] = set()
    total_meters = 0.0

    # 2. Find best candidate roll for each line on warehouse storage
    for line in open_lines:
        done_p = sum(float(r.good_pieces or 0) for r in line.reports if r.counts_toward_line)
        rem_p = max(0.0, float(line.quantity_pieces or 0) - done_p)
        if rem_p <= 0:
            continue

        needed_m = rem_p * float(line.length_m or 0.0)
        total_meters += needed_m

        # Find matching unit in stock
        cand_unit = (
            db.query(MaterialUnit)
            .join(MaterialUnit.material_sku)
            .filter(
                MaterialUnit.status == UnitStatus.NA_KHRANENII,
                MaterialUnit.length_m > 0,
            )
            .filter(
                MaterialUnit.material_sku.has(
                    material_id=line.material_id,
                    color_id=line.color_id,
                    thickness_id=line.thickness_id,
                )
            )
            .order_by(MaterialUnit.length_m.asc())
            .first()
        )

        loc_code = cand_unit.location_code if cand_unit and cand_unit.location_code else "Не размещён"
        _, prefix, r_num, s_num = _parse_location_key(loc_code)
        rack_str = f"{prefix}-{r_num}" if r_num < 999 else "Зона подготовки"
        racks_set.add(rack_str)

        pick_id = f"PICK-{line.task_id}-{line.id}"
        pick_items.append(
            PickRouteItem(
                pick_id=pick_id,
                unit_id=cand_unit.id if cand_unit else None,
                location_code=loc_code,
                rack_code=rack_str,
                shelf_num=s_num,
                task_id=line.task_id,
                task_name=line.task.name or f"Задание #{line.task_id}",
                task_line_id=line.id,
                target_area=line.task.area,
                target_area_name=area_names.get(line.task.area, line.task.area),
                material_name=mat_names.get(line.material_id, ""),
                color_name=col_names.get(line.color_id, ""),
                thickness_val=th_vals.get(line.thickness_id, 0.0),
                width_mm=float(line.width_mm or 0.0),
                length_needed_m=needed_m,
                unit_length_m=float(cand_unit.length_m) if cand_unit else None,
                barcode=str(cand_unit.id) if cand_unit else None,
                is_verified=False,
            )
        )

    # 3. Sort by natural warehouse path
    pick_items.sort(key=lambda item: _parse_location_key(item.location_code))

    wave_id = f"WAVE-{date.today().strftime('%Y%m%d')}-01"
    return PickRouteWave(
        wave_id=wave_id,
        created_at=datetime.now().isoformat(),
        target_area=area,
        total_items=len(pick_items),
        total_meters=total_meters,
        distinct_racks_count=len(racks_set),
        items=pick_items,
    )


def verify_pick_scanned_barcode(
    db: Session,
    scanned_barcode: str,
    expected_task_line_id: int,
) -> dict[str, Any]:
    """Верификация сканирования QR-кода при снятии рулона со стеллажа."""
    clean_code = scanned_barcode.strip().lstrip("U-").lstrip("0")
    if not clean_code.isdigit():
        return {
            "verified": False,
            "error": "Неверный формат штрихкода (ожидается числовой ID рулона)",
        }

    unit_id = int(clean_code)
    unit = db.get(MaterialUnit, unit_id)
    if not unit:
        return {"verified": False, "error": f"Рулон #{unit_id} не найден в базе"}

    line = db.get(ProductionTaskLine, expected_task_line_id)
    if not line:
        return {"verified": False, "error": "Строка производственного задания не найдена"}

    sku = unit.material_sku
    if not sku:
        return {"verified": False, "error": "У рулона не привязана номенклатура SKU"}

    # Проверка совпадения материала, цвета и толщины
    if (
        sku.material_id != line.material_id
        or sku.color_id != line.color_id
        or sku.thickness_id != line.thickness_id
    ):
        mat_obj = db.get(Material, sku.material_id) if sku.material_id else None
        mat_name = mat_obj.name if mat_obj else ""
        col_obj = db.get(Color, sku.color_id) if sku.color_id else None
        col_name = col_obj.name if col_obj else ""
        return {
            "verified": False,
            "error": f"ОШИБКА ПЕРЕСОРТИЦЫ! Вы отсканировали {col_name} ({mat_name}), а для задания требуется другой декор.",
        }

    # Проверка ширины рулона (допустима равная или чуть большая с запасом на обрезку)
    if float(unit.width_mm) < float(line.width_mm or 0.0) - 2.0:
        return {
            "verified": False,
            "error": f"Ширина рулона ({int(unit.width_mm)} мм) меньше требуемой ширины заготовки ({int(line.width_mm)} мм)!",
        }

    return {
        "verified": True,
        "unit_id": unit.id,
        "location_code": unit.location_code,
        "length_m": float(unit.length_m),
        "width_mm": float(unit.width_mm),
        "message": f"Рулон #{unit.id} подтверждён! Соответствует заданию.",
    }
