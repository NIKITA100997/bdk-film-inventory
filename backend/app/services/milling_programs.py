"""Программы фрезеровки панелей (07.10.2026): справочник и автоподбор.

Название программы разбирается на признаки — серия, подверсия, ширина
двери, молдинг, вариант:
  «В10.2_800х2000_(М5х3)» → В-10, подверсия 2, ширина 800, молдинг М5х3
  «Е17.2_(М5х3)»          → Е-17, подверсия 2, любая ширина
  «В5_F3_700х2000_1»      → В-5/Ф3, ширина 700, вариант 1
  «Grafiti_5_800х2000_2»  → В-34 (Графити 5), ширина 800, вариант 2
Вариант «_1» — все плёнки, кроме ПЭТ; «_2» — ПЭТ (ответ пользователя).

Дверь даёт серию (вариант свойства «серия»), ширину и ПЭТ — из позиции;
подверсию («В-10.2») и молдинг («(м5х3 …», «(м9 …») — из исходной строки
графика (ProductionOrderLine.source_text). Подходит ровно одна программа —
подставляется в строку задания с фрезеровкой; иначе пусто («уточнить у
конструктора», вписывают в черновике).
"""

import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

GRAFITI_SERIES = {"2": "В-28", "5": "В-34"}

_RE_GRAFITI = re.compile(r"^grafiti_(\d)_(\d{3})х2000(?:_([12]))?$", re.I)
_RE_PROG = re.compile(
    r"^([АВЕН])-?(\d+)(?:_F(\d))?(?:\.(\d))?(?:_(\d{3})х2000)?(?:х2000)?(?:_\((М[^)]+)\))?(?:_([12]))?$", re.I
)


@dataclass
class ProgramSpec:
    series: str
    version: str | None = None
    width: int | None = None
    molding: str | None = None
    variant: int | None = None


def _norm_molding(m: str | None) -> str | None:
    if not m:
        return None
    m = m.upper().replace("M", "М").replace("X", "Х").replace(" ", "")
    return "/".join(p if p.startswith("М") else "М" + p for p in m.split("/"))


def parse_program(name: str) -> ProgramSpec | None:
    s = (name or "").strip().replace("x", "х").replace("X", "х")
    g = _RE_GRAFITI.match(s)
    if g:
        return ProgramSpec(series=GRAFITI_SERIES.get(g.group(1), f"Grafiti {g.group(1)}"), width=int(g.group(2)),
                           variant=int(g.group(3)) if g.group(3) else None)
    m = _RE_PROG.match(s)
    if not m:
        return None
    letter, num, f, ver, width, mold, var = m.groups()
    series = f"{letter.upper()}-{num}" + (f"/Ф{f}" if f else "")
    return ProgramSpec(series=series, version=ver, width=int(width) if width else None, molding=_norm_molding(mold),
                       variant=int(var) if var else None)


_RE_VERSION = re.compile(r"^\s*[АВЕНA-Z]-?\d+(?:/[ФF]\d)?\.(\d)", re.I)
_RE_MOLD = re.compile(r"\(\s*м\s*(\d+(?:\s*х\s*\d+)?(?:\s*/\s*м?\s*\d+\s*х\s*\d+)?)|молдинг\s+(\d+\s*х\s*\d+)", re.I)


def door_spec_from_text(text: str | None) -> tuple[str | None, str | None]:
    """Подверсия и молдинг из строки графика: «В-10.2 (м5х3 кромка 4х) …»."""
    t = text or ""
    v = _RE_VERSION.match(t)
    m = _RE_MOLD.search(t)
    mold = None
    if m:
        mold = _norm_molding(re.sub(r"\s+", "", m.group(1) or m.group(2)))
    return (v.group(1) if v else None), mold


def suggest(programs: list, series: str, width: int | None, version: str | None, molding: str | None, pet: bool) -> str | None:
    """Ровно одна подходящая программа — её название, иначе None."""
    want_variant = 2 if pet else 1
    cands = []
    for p in programs:
        spec = parse_program(p.name)
        if spec is None or spec.series != series:
            continue
        if spec.width is not None and spec.width != width:
            continue
        if spec.variant is not None and spec.variant != want_variant:
            continue
        if spec.molding is not None and molding is not None and spec.molding != molding:
            continue
        if spec.version is not None and version is not None and spec.version != version:
            continue
        cands.append((p, spec))
    if len(cands) > 1 and version is not None:
        exact = [c for c in cands if c[1].version == version]
        cands = exact or cands
    if len(cands) > 1 and molding is not None:
        exact = [c for c in cands if c[1].molding == molding]
        cands = exact or cands
    return cands[0][0].name if len(cands) == 1 else None


def fill_programs(db: Session, order) -> int:
    """Строкам заданий с фрезеровкой (операция «нужна программа») без
    программы — подобрать по двери строки заказа. Возвращает, сколько
    подставлено. Без commit."""
    from app.models.milling_programs import MillingProgram
    from app.models.dictionaries import PartStage
    from app.models.items import Item, ItemPropertyOption
    from app.models.production import ProductionTask
    from app.services import type_rules
    from app.services.operation_roles import needs_program

    programs = db.query(MillingProgram).filter(MillingProgram.is_active.is_(True)).all()
    if not programs:
        return 0
    lines = {l.id: l for l in order.lines}
    cache: dict[int, tuple] = {}
    n = 0
    for t in db.query(ProductionTask).filter(ProductionTask.production_order_id == order.id):
        for ln in t.lines:
            if ln.program or not ln.order_line_id or ln.order_line_id not in lines:
                continue
            stage = db.get(PartStage, ln.part_stage_id) if ln.part_stage_id else None
            if not needs_program(stage):
                continue
            ol = lines[ln.order_line_id]
            if ol.id not in cache:
                item = db.get(Item, ol.item_id)
                series = width = None
                pet = False
                if item is not None and item.type is not None:
                    vals = type_rules.item_values(db, item)
                    for p in item.type.properties:
                        v = vals.get(p.id)
                        if p.code == "серия" and v:
                            opt = db.get(ItemPropertyOption, v)
                            series = opt.value if opt else None
                        elif p.code == "ширина" and v is not None:
                            width = int(float(v))
                        elif p.code == "цвет" and v:
                            label = db.get(ItemPropertyOption, v).value if p.value_type == "list" else str(v)
                            pet = "пэт" in (label or "").lower()
                version, molding = door_spec_from_text(getattr(ol, "source_text", None))
                cache[ol.id] = (series, width, version, molding, pet)
            series, width, version, molding, pet = cache[ol.id]
            if not series:
                continue
            name = suggest(programs, series, width, version, molding, pet)
            if name:
                ln.program = name
                n += 1
    return n
