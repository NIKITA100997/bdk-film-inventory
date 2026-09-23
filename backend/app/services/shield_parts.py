"""Детали п/ф щитовой двери (раздел про производство щитовых дверей).

Три детали на размер двери — все обычные Part/PartStage, те же экраны
«Учёт п/ф»/«Остатки п/ф», что у коробки:
  • Каркас WxHxT — собранный каркас, расходуется на Склейке;
  • Панель TxWxH — сырая панель без цвета (Распил → Фрезеровка →
    Шлифовка), как на листах распила/фрезеровки панелей в графиках;
  • Панель TxWxH <цвет> — ламинированная; рождается из сырой отчётом
    Окутки/Ламинации и расходуется на Склейке вместе с каркасом.

Размер каркаса и щита по техкарте — дверь + 10 мм по ширине и высоте."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.dictionaries import Part, PartStage
from app.models.door_series import DoorSeries

# Участок цеха щитовых дверей — каркас и ламинированные панели лежат на нём
# до Склейки (участок = склад, как у п/ф коробки). Этапы деталей
# редактируются в справочнике деталей, если реальный участок другой.
SHIELD_WORKSHOP_AREA = "shchitovye_dveri"

FOOTPRINT_ALLOWANCE_MM = 10


def shield_footprint(door_width_mm: int, door_height_mm: int) -> tuple[int, int]:
    return door_width_mm + FOOTPRINT_ALLOWANCE_MM, door_height_mm + FOOTPRINT_ALLOWANCE_MM


def _mm(value: float) -> str:
    return f"{float(value):g}"


def frame_part_name(w: int, h: int, frame_thickness_mm: float) -> str:
    return f"Каркас {w}х{h}х{_mm(frame_thickness_mm)}"


def raw_panel_part_name(w: int, h: int, panel_thickness_mm: float) -> str:
    return f"Панель {_mm(panel_thickness_mm)}х{w}х{h}"


def laminated_panel_part_name(w: int, h: int, panel_thickness_mm: float, color: str) -> str:
    return f"{raw_panel_part_name(w, h, panel_thickness_mm)} {' '.join(color.split())}"


FRAME_STAGES = [("sborka_karkasa", "Сборка каркаса")]
RAW_PANEL_STAGES = [("raspil", "Распил"), ("frezerovka", "Фрезеровка"), ("shlifovka", "Шлифовка")]
LAMINATED_PANEL_STAGES = [("gotova_k_skleyke", "Готова к склейке")]


def find_or_create_part(
    db: Session, *, name: str, width_mm: float, length_m: float, stages: list[tuple[str, str]], area: str
) -> Part:
    """Деталь по точному названию — если уже есть (заведена раньше вручную или
    прошлым запуском), возвращается как есть: её этапы могли настроить под
    реальный маршрут, перезаписывать их нельзя."""
    part = db.query(Part).filter(Part.name == name).first()
    if part is not None:
        return part
    part = Part(name=name, width_mm=width_mm, length_m=length_m, area=area, is_active=True)
    db.add(part)
    db.flush()
    for i, (code, stage_name) in enumerate(stages, 1):
        db.add(PartStage(part_id=part.id, sequence_order=i, code=code, name=stage_name, area=area))
    db.flush()
    db.refresh(part)
    return part


@dataclass(frozen=True)
class ShieldParts:
    frame: Part
    raw_panel: Part
    laminated_panel: Part


def ensure_shield_parts(
    db: Session, *, series: DoorSeries, door_width_mm: int, door_height_mm: int, color: str
) -> ShieldParts:
    w, h = shield_footprint(door_width_mm, door_height_mm)
    frame_t = float(series.frame_thickness_mm)
    panel_t = float(series.panel_mdf_thickness_mm)
    length_m = h / 1000
    return ShieldParts(
        frame=find_or_create_part(
            db, name=frame_part_name(w, h, frame_t), width_mm=w, length_m=length_m,
            stages=FRAME_STAGES, area=SHIELD_WORKSHOP_AREA,
        ),
        raw_panel=find_or_create_part(
            db, name=raw_panel_part_name(w, h, panel_t), width_mm=w, length_m=length_m,
            stages=RAW_PANEL_STAGES, area=SHIELD_WORKSHOP_AREA,
        ),
        laminated_panel=find_or_create_part(
            db, name=laminated_panel_part_name(w, h, panel_t, color), width_mm=w, length_m=length_m,
            stages=LAMINATED_PANEL_STAGES, area=SHIELD_WORKSHOP_AREA,
        ),
    )
