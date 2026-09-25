"""Вид «Материал» и нормы п/ф МК/панелей (25.09.2026).

Решения пользователя: из склеенного щита — все стоевые, поперечные и пороги
МК и планки из техкарты склеенных заготовок; у них общая заготовка того же
размера (нормы листов — у изделий техкарты: стоевая 36×108×2035,
поперечная/планка 30×110×1840, планка 26×30×1800, Нео 34×200/120/90×1840);
остальные детали фрезеруются прямо из МДФ своей толщины (состав — МДФ, м²
по размеру детали, расход на фрезеровке), заготовка им не нужна.

  • вид «Материал» (м²) и позиции «МДФ N мм», «Фанера 24 мм»;
  • у типа «Деталь МК/панели» — признак «из склеенной заготовки» и два
    правила: склеенная → заготовка того же размера, иначе → «МДФ {толщина}
    мм» ширина×длина;
  • у «Заготовки п/ф» — «Склейка сэндвича» (Фабрика) → «Склейка МДФ с
    заготовкой» (участок п/ф: распил, облицовка, шлифовка) → «Готово»;
    состав заготовок из техкарты (лист 1200 мм, выход с закладки);
  • заготовки, ставшие ненужными (по ним ничего нет), — удаляются.

Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_pf_materials.py [--dry-run]"""

import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.security import get_current_user  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemComponent, ItemKind, ItemType  # noqa: E402
from app.models.part_units import PartUnit, PartUnitEvent  # noqa: E402
from app.models.production import ProductionTaskLine  # noqa: E402
from app.models.users import User  # noqa: E402
from app.services import type_rules  # noqa: E402

DRY = "--dry-run" in sys.argv
FACTORY, GLUE_AREA = "fabrika", "skleyka_mdf_s_zagotovkoy"
SANDWICH, GLUE, READY = "Склейка сэндвича", "Склейка МДФ с заготовкой", "Готово"
GLUED = {"36х108х2035", "30х110х1840", "26х30х1800", "34х200х1840", "34х120х1840", "34х90х1840"}
# Решение пользователя 25.09: все стоевые, поперечные и пороги МК — из
# склеенного щита (любого размера); «… МДФ» — цельный МДФ, не щит.
GLUED_PROFILES = ("Стоевая", "Поперечная", "Порог")
SHEET = 1.2 * 1.84  # лист 929(1200)… — закладка поперечных/Нео: 929×1840 мм
# Состав склеенной заготовки на 1 шт: (материал, м² на 1 шт, операция).
NEO16 = 8 * 0.929 * 1.84 / 40  # 2 закладки по 4 листа МДФ 16 на 40 деталей
BLANK_BOM = {
    "36х108х2035": [("МДФ 22 мм", 3 * 1.2 * 2.035 / 40, SANDWICH), ("Фанера 24 мм", 6 * 1.2 * 0.4 / 40, SANDWICH),
                    ("МДФ 6 мм", 80 * 0.114 * 2.035 / 40, GLUE)],
    "30х110х1840": [("МДФ 22 мм", 0.929 * 1.84 / 40, SANDWICH), ("МДФ 16 мм", 6 * 0.929 * 1.84 / 40, SANDWICH),
                    ("МДФ 6 мм", 80 * 0.118 * 1.84 / 40, GLUE)],
    "34х200х1840": [("МДФ 16 мм", 6 * 0.929 * 1.84 / 20, SANDWICH), ("МДФ 8 мм", 0.929 * 1.84 / 20, SANDWICH),
                    ("МДФ 8 мм", 40 * 0.208 * 1.84 / 20, GLUE)],
    "34х120х1840": [("МДФ 16 мм", NEO16, SANDWICH), ("МДФ 8 мм", 80 * 0.128 * 1.84 / 40, GLUE)],
    "34х90х1840": [("МДФ 16 мм", NEO16, SANDWICH), ("МДФ 8 мм", 80 * 0.128 * 1.84 / 40, GLUE)],
    # Планка 26×30 — из облицованной заготовки поперечной: 3 шт из одной.
    "26х30х1800": [("Заготовка МК 30х110х1840", 1 / 3, GLUE)],
}


def blank_bom(size: str):
    """Состав заготовки по размеру. Стоевые (36×100/108/110/120, 40×120) —
    пакет стоевой из техкарты (пользователь: «это тоже щиты»); длиннее 2035
    («на 2400 щиты длиннее делают») — МДФ пропорционально длине, фанера та
    же (вставки по 400 мм в тех же зонах). Остальное — по техкарте или нет."""
    if size in BLANK_BOM:
        return BLANK_BOM[size]
    t, w, length = (int(x) for x in size.split("х"))
    if (t, w) in {(36, 100), (36, 108), (36, 110), (36, 120), (40, 120)}:
        k = length / 2035
        return [(m, q * k if m.startswith("МДФ") else q, op) for m, q, op in BLANK_BOM["36х108х2035"]]
    return None


db = SessionLocal()
admin = db.query(User).filter(User.is_superuser.is_(True), User.is_active.is_(True)).order_by(User.id).first()
app.dependency_overrides[get_current_user] = lambda: admin
c = TestClient(app)


def ok(r, what):
    if r.status_code >= 300:
        raise SystemExit(f"{what}: {r.status_code} {r.text}")
    return r.json()


# --- вид «Материал» и позиции ---
kind = db.query(ItemKind).filter(ItemKind.code == "material").first()
if kind is None:
    kind = ItemKind(code="material", name="Материал", unit="м²", lot_tracking=False, sort_order=5, is_active=True)
    db.add(kind)
    db.flush()
    print("вид создан: Материал (м²)")
# Опечатка «Порог 300х200х1840 ПАЗ-15» (есть правильная «Порог 30х200…») —
# в архив, если по ней ничего нет; архивные детали не обрабатываются.
typo = db.query(Part).filter(Part.name == "Порог 300х200х1840 ПАЗ-15", Part.is_active.is_(True)).first()
if typo and db.query(Part).filter(Part.name == "Порог 30х200х1840 ПАЗ-15").first() and not db.query(PartUnit.id).filter(PartUnit.part_id == typo.id).first():
    typo.is_active = False
    typo.item.is_active = False
    print("в архив (опечатка):", typo.name)
for arch in db.query(Part).filter(Part.name == "Порог 300х200х1840 ПАЗ-15", Part.is_active.is_(False)):
    db.query(ItemComponent).filter(ItemComponent.parent_item_id == arch.item_id).delete()
db.flush()  # autoflush выключен: архив и снятый состав — до выборки деталей ниже
detail_type = db.query(ItemType).filter(ItemType.name == "Деталь МК/панели").one()
blank_type = db.query(ItemType).filter(ItemType.name == "Заготовка п/ф").one()
details = (
    db.query(Item).join(Part, Part.item_id == Item.id)
    .filter(Item.type_id == detail_type.id, Item.is_model.is_(False), Part.is_active.is_(True)).all()
)


def size_key(values):
    return "х".join(f"{values[c]:g}" for c in ("толщина", "ширина", "длина"))


def ctx_of(item):
    return type_rules.context_from_values(db, detail_type, type_rules.item_values(db, item))


glued_of = {}
thicknesses = set()
for item in details:
    ctx = ctx_of(item)
    # «… МДФ» — цельный МДФ, не щит (пользователь: «МДФ — это МДФ»).
    glued = (
        ctx["линия"] == "МК"
        and "МДФ" not in (ctx.get("исполнение") or "")
        and (str(ctx["профиль"]).startswith(GLUED_PROFILES) or size_key(ctx) in GLUED)
    )
    glued_of[item.id] = glued
    if not glued:
        thicknesses.add(ctx["толщина"])
materials = {f"МДФ {t:g} мм" for t in thicknesses} | {m for bom in BLANK_BOM.values() for m, _, _ in bom if not m.startswith("Заготовка")}
mat_items = {}
for name in sorted(materials):
    it = db.query(Item).filter(Item.kind_id == kind.id, Item.name == name).first()
    if it is None:
        it = Item(kind_id=kind.id, name=name)
        db.add(it)
        db.flush()
        print("материал заведён:", name)
    mat_items[name] = it
db.commit()  # вид и материалы — до правил (правила ищут материал по названию)

# --- правила типов ---
dt = ok(c.get("/api/item-types"), "types")
dt_out = next(t for t in dt if t["id"] == detail_type.id)
if "склеенная" not in {p["code"] for p in dt_out["properties"]}:
    ok(c.post(f"/api/item-types/{detail_type.id}/properties", json={
        "code": "склеенная", "name": "Из склеенной заготовки (техкарта)", "value_type": "bool", "is_required": False,
    }), "prop склеенная")
ok(c.put(f"/api/item-types/{detail_type.id}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "condition": "склеенная", "operation_name": "Фрезеровка",
     "component_type_id": blank_type.id, "width_expr": "ширина", "length_expr": "длина",
     "component_values": {"линия": "линия", "толщина": "толщина", "ширина": "ширина", "длина": "длина",
                          "материал": '"МДФ" if "МДФ" in исполнение else ""'}},
    {"name_template": "МДФ {толщина} мм", "qty_expr": "ширина * длина / 1000000", "condition": "not склеенная",
     "operation_name": "Фрезеровка"},
]), "detail rules")
ok(c.put(f"/api/item-types/{blank_type.id}/operations", json=[
    {"name": SANDWICH, "area": FACTORY},
    {"name": GLUE, "area": GLUE_AREA},
    {"name": READY, "area": None},
]), "blank ops")
db.expire_all()
detail_type = db.get(ItemType, detail_type.id)
glued_prop = next(p for p in detail_type.properties if p.code == "склеенная")

# --- детали: признак и пересчёт состава по правилам ---
parts_before = db.query(Part).count()
changed, errors = 0, []
for item in details:
    values = type_rules.item_values(db, item)
    want = glued_of[item.id]
    comps_before = sorted((x.component_item_id, float(x.qty_per_unit)) for x in db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id))
    values[glued_prop.id] = want
    sp = db.begin_nested()
    type_rules._set_values(db, item, detail_type, {k: v for k, v in values.items() if v not in (None, "")})
    res = type_rules.apply(db, item)
    if res.errors:
        sp.rollback()
        errors.append(f"{item.name}: {res.errors}")
        continue
    sp.commit()
    comps_after = sorted((x.component_item_id, float(x.qty_per_unit)) for x in db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id))
    changed += comps_before != comps_after
# Новыми могут быть только заготовки (размеры щита вне техкарты — без норм).
new_blanks = [p.name for p in db.query(Part).order_by(Part.id.desc()).limit(db.query(Part).count() - parts_before)]
new_parts = sum(1 for n in new_blanks if not n.startswith("Заготовка"))

# --- склеенные заготовки: маршрут типа и состав из техкарты ---
blank_items = db.query(Item).filter(Item.type_id == blank_type.id).all()
for item in blank_items:
    type_rules.apply(db, item)  # маршрут: сэндвич → облицовка → готово
db.flush()
blanks_done, no_norms = [], []
for item in blank_items:
    part = db.query(Part).filter(Part.item_id == item.id).first()
    m = re.search(r"(\d+х\d+х\d+)$", part.name) if part else None
    bom = blank_bom(m.group(1)) if m and part.name.startswith("Заготовка МК ") else None
    if not bom:
        no_norms.append(part.name)
        continue
    stages = {s.name: s.id for s in item.stages}
    db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id, ItemComponent.source == "manual").delete()
    for i, (mat, qty, op) in enumerate(bom, start=1):
        comp = mat_items.get(mat) or db.query(Part).filter(Part.name == mat).one().item
        db.add(ItemComponent(parent_item_id=item.id, component_item_id=comp.id, qty_per_unit=round(qty, 4),
                             stage_id=stages[op], source="manual", sort_order=i))
    blanks_done.append(part.name)
db.flush()

# --- ненужные заготовки: на них ничего не ссылается ---
removed = []
for item in db.query(Item).filter(Item.type_id == blank_type.id).all():
    part = db.query(Part).filter(Part.item_id == item.id).first()
    if part is None:
        continue
    used = (
        db.query(ItemComponent.id).filter(ItemComponent.component_item_id == item.id).first()
        or db.query(PartUnit.id).filter(PartUnit.part_id == part.id).first()
        or db.query(ProductionTaskLine.id).filter(ProductionTaskLine.part_id == part.id).first()
        or db.query(PartUnitEvent.id).join(PartUnit, PartUnit.id == PartUnitEvent.part_unit_id).filter(PartUnit.part_id == part.id).first()
    )
    if used:
        continue
    db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id).delete()
    removed.append(part.name)
    db.delete(part)
db.flush()

glued_n = sum(glued_of.values())
print(f"деталей: из склеенной заготовки {glued_n}, из МДФ {len(glued_of) - glued_n}; состав изменился у {changed}; новых деталей п/ф: {new_parts}")
print("состав заготовок (техкарта, стоевые — по пакету стоевой):", blanks_done)
print("заготовки без норм:", no_norms)
print("новые заготовки (без норм — размера нет в техкарте):", [n for n in new_blanks if n.startswith("Заготовка")])
print(f"удалено ненужных заготовок: {len(removed)}")
if errors:
    print("ошибки:", *errors, sep="\n  ")
if DRY or errors or new_parts:
    db.rollback()
    print("ничего не записано (кроме вида, материалов и правил типов)" + (" — пробный прогон" if DRY else ""))
else:
    db.commit()
