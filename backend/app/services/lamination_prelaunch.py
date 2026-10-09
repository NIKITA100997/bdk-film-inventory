"""Окутка панелей отдельно (09.10): задания на ламинацию панелей заказа
до запуска всего заказа — широкоформатная окутка на Фабрике или прессы.

Заказ остаётся черновиком: остальные участки (распил, склейка, сборка…)
запускаются позже обычным запуском, а уже запущенная окутка в нём не
повторяется — release_pf вычитает её (prelaunched_film). Строка задания —
панель целиком по заказу (одинаковые панели разных строк заказа сложены),
с плёнкой и штрипсом участка, как при обычном запуске."""

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.areas import Area
from app.models.dictionaries import Color, Material, Part, Thickness
from app.models.production import ProductionTask, ProductionTaskLine
from app.models.production_orders import ORDER_DRAFT, ProductionOrder
from app.services.areas import cuts_film_on_site
from app.services.operation_roles import big_batch, film_stage
from app.services.panel_film import _film_width, lamination_line_film, panel_film_spec  # noqa: PLC2701
from app.services.planning import order_pf_needs
from app.services.production_orders import OrderError


@dataclass
class LamRow:
    part_id: int
    part_name: str
    quantity: float  # нужно заказу (запуск под заказ)
    launched: float  # уже запущено окуткой отдельно
    press_area: str | None  # участок по маршруту
    factory_area: str | None  # куда крупные партии
    factory_min_pieces: float | None
    film: str | None  # плёнка, если определилась
    strip_mm: dict[str, float | None] = field(default_factory=dict)  # участок → штрипс (None — режут сами)


def prelaunched_film(db: Session, order: ProductionOrder) -> dict[int, float]:
    """Штук панели, уже запущенных на операцию с плёнкой в заданиях заказа."""
    out: dict[int, float] = defaultdict(float)
    parts: dict[int, Part | None] = {}
    lines = (
        db.query(ProductionTaskLine)
        .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
        .filter(ProductionTask.production_order_id == order.id, ProductionTaskLine.part_id.isnot(None))
        .all()
    )
    for ln in lines:
        if ln.part_id not in parts:
            parts[ln.part_id] = db.get(Part, ln.part_id)
        part = parts[ln.part_id]
        lam = film_stage(part.stages) if part is not None else None
        if lam is not None and ln.part_stage_id == lam.id:
            out[ln.part_id] += float(ln.quantity_pieces)
    return dict(out)


def _film_name(db: Session, part: Part) -> str | None:
    spec = panel_film_spec(db, part)
    if spec is None:
        return None
    m, c, t = db.get(Material, spec[0]), db.get(Color, spec[1]), db.get(Thickness, spec[2])
    return f"{m.name} {c.name} {float(t.value_mm):g}" if m and c and t else None


def lamination_rows(db: Session, order: ProductionOrder) -> list[LamRow]:
    """Панели заказа с операцией плёнки — сколько нужно, сколько уже запущено."""
    need: dict[int, float] = defaultdict(float)
    for n in order_pf_needs(db, order):
        need[n.part_id] += n.launch
    pre = prelaunched_film(db, order)
    rows: list[LamRow] = []
    for part_id, qty in need.items():
        part = db.get(Part, part_id)
        lam = film_stage(part.stages) if part is not None else None
        if lam is None or (qty <= 0 and not pre.get(part_id)):
            continue
        target, min_pieces = big_batch(db, lam.area)
        strip = {
            a: (None if cuts_film_on_site(db, a) else _film_width(db, part, lam, a)[0])
            for a in {lam.area, target} if a
        }
        rows.append(
            LamRow(
                part_id=part.id, part_name=part.name, quantity=round(qty, 2), launched=round(pre.get(part_id, 0.0), 2),
                press_area=lam.area, factory_area=target, factory_min_pieces=min_pieces,
                film=_film_name(db, part), strip_mm=strip,
            )
        )
    return sorted(rows, key=lambda r: r.part_name.lower())


@dataclass
class LamPick:
    part_id: int
    quantity: float
    area: str


def release_lamination(db: Session, order: ProductionOrder, picks: list[LamPick], user_id: int) -> list[ProductionTask]:
    """Задания на окутку/ламинацию выбранных панелей (без commit): задание на
    участок, строка на панель. Заказ остаётся черновиком."""
    if order.status != ORDER_DRAFT:
        raise OrderError("Окутку отдельно запускают до запуска заказа — заказ уже запущен")
    picks = [p for p in picks if p.quantity > 0]
    if not picks:
        raise OrderError("Не выбрано ни одной панели")
    area_names = {a.code: a.name for a in db.query(Area)}
    tasks: dict[str, ProductionTask] = {}
    for p in picks:
        part = db.get(Part, p.part_id)
        lam = film_stage(part.stages) if part is not None else None
        if lam is None:
            raise OrderError(f"У детали #{p.part_id} нет операции с плёнкой")
        if p.area not in area_names:
            raise OrderError(f"Участок «{p.area}» не найден")
        task = tasks.get(p.area)
        if task is None:
            task = ProductionTask(
                name=f"Заказ №{order.id} «{order.name}» — окутка панелей, {area_names[p.area]}"[:255],
                area=p.area, created_by=user_id, production_order_id=order.id, is_active=True,
            )
            db.add(task)
            tasks[p.area] = task
        film = lamination_line_film(db, part, lam, p.area)
        task.lines.append(
            ProductionTaskLine(
                quantity_pieces=p.quantity, part_stage_id=lam.id, part_id=part.id, part_name=part.name,
                width_mm=float(part.width_mm or 0), length_m=film.pop("length_m", 0), **film,
            )
        )
    db.flush()
    return list(tasks.values())
