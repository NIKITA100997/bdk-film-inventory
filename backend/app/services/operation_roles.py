"""Вид операции маршрута (03.10) — признак, а не название: раньше логика
узнавала ламинацию по слову «Ламинация»/«Окутка», а фрезеровку с
программой — по коду участка. Переименовали этап — ничего не ломается.

  film    — операция с плёнкой: строка задания несёт плёнку, склад выдаёт
            под неё штрипс или рулон, отчёт списывает метраж;
  program — нужна программа станка (фрезеровка): раскладка проверяет,
            что программа указана, и предупреждает о нестандартном размере.
"""

from sqlalchemy.orm import Session

FILM = "film"
PROGRAM = "program"
ROLES = {FILM: "с плёнкой", PROGRAM: "программа станка"}
KEEP = "keep"  # в запросе на сохранение маршрута: вид не менять


def clean_role(role: str | None) -> str | None:
    if role in (None, "", "none"):
        return None
    if role not in ROLES:
        raise ValueError(f"Неизвестный вид операции: {role}")
    return role


def is_film(stage) -> bool:
    return stage is not None and getattr(stage, "role", None) == FILM


def needs_program(stage) -> bool:
    return stage is not None and getattr(stage, "role", None) == PROGRAM


def film_stage(stages):
    """Первая операция с плёнкой в маршруте (по порядку)."""
    return next((s for s in sorted(stages, key=lambda s: s.sequence_order) if is_film(s)), None)


def big_batch(db: Session, area_code: str | None) -> tuple[str | None, float | None]:
    """Куда предлагать крупные партии операции этого участка и от скольких
    штук (настройка участка)."""
    from app.models.areas import Area

    area = db.get(Area, area_code) if area_code else None
    if area is None or not area.big_batch_area or not area.big_batch_min_pieces:
        return None, None
    return area.big_batch_area, float(area.big_batch_min_pieces)


def suggest_area(db: Session, area_code: str | None, pieces: float) -> str | None:
    target, min_pieces = big_batch(db, area_code)
    return target if target and pieces >= min_pieces else area_code
