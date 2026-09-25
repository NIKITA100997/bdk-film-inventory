"""Настройка щитовых дверей на единой модели (24.09.2026) — только данные,
никакого кода под щитовые: участки, типы номенклатуры с правилами, серии.

Повторяемо: уже заведённое пропускается. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_shield_doors.py

Решения пользователя 24.09: отдельный участок на каждую операцию;
ламинированная панель — отдельная позиция по цвету; черновик деталей
(«Панель щитовой двери …», «Заготовка для щита …») — в архив.

25.09 — по спецификациям 1С («Модели» щитовых) и решениям пользователя:
заготовка МДФ — общая для всех серий и цветов, её последняя операция
«Готово» без участка (общий запас: дальше — на ламинацию или на
фрезеровку); панель с узором (у двери с молдингом) — «фрезеровка →
ламинация», а на ПЭТ (по плёнке) — «ламинация → фрезеровка»; каркас
собирается из стоек/поперечных/усилителей/вставок, пенопласт — на склейку
щита по таблице ширин. Кромка, молдинг, стекло — позже, с видом «Материал»."""

import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.security import get_current_user  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.users import User  # noqa: E402

LAMINATION_AREA = "uchastok_membranno_vakuumnykh_pressov"
AREAS = [
    "Сборка каркасов",
    "Распил панелей",
    "Фрезеровка панелей",
    "Шлифовка панелей",
    "Склейка щитов",
    "Фрезеровка периметра щитов",
    "Сборка щитовых дверей",
    "Кромка щитовых дверей",
    "Фрезеровка под замок",
    "Упаковка щитовых дверей",
]

db = SessionLocal()
admin = db.query(User).filter(User.is_superuser.is_(True), User.is_active.is_(True)).order_by(User.id).first()
app.dependency_overrides[get_current_user] = lambda: admin
c = TestClient(app)


def ok(r, what):
    if r.status_code >= 300:
        raise SystemExit(f"{what}: {r.status_code} {r.text}")
    return r.json()


# --- участки ---
areas = {a["name"]: a for a in ok(c.get("/api/areas"), "areas")}
if LAMINATION_AREA not in {a["code"] for a in areas.values()}:
    raise SystemExit("Нет участка мембранно-вакуумных прессов")
for name in AREAS:
    if name not in areas:
        a = ok(c.post("/api/areas", json={"name": name, "requires_daily_plan": False}), f"area {name}")
        areas[name] = a
        print("участок создан:", name, a["code"])
A = {name: areas[name]["code"] for name in AREAS}

# --- типы ---
types = {(t["kind_code"], t["name"]): t for t in ok(c.get("/api/item-types"), "types")}


def ensure_type(kind, name, props, template):
    t = types.get((kind, name))
    if t is None:
        t = ok(c.post("/api/item-types", json={"kind_code": kind, "name": name}), f"type {name}")
        print("тип создан:", name)
    have = {p["code"] for p in t["properties"]}
    for p in props:
        if p["code"] not in have:
            ok(c.post(f"/api/item-types/{t['id']}/properties", json=p), f"prop {p['name']}")
    ok(c.put(f"/api/item-types/{t['id']}", json={"name_template": template}), f"template {name}")
    t = next(x for x in ok(c.get("/api/item-types"), "types") if x["id"] == t["id"])
    types[(kind, name)] = t
    return t


num = lambda code, name, unit="мм": {"code": code, "name": name, "value_type": "number", "unit": unit, "is_required": True}

frame = ensure_type(
    "pf", "Каркас щитовой двери",
    [num("ширина", "Ширина"), num("высота", "Высота"), num("толщина", "Толщина")],
    "Каркас {ширина}х{высота}х{толщина}",
)
# Сырая панель называлась «Панель щитовая» — теперь как в 1С: «Заготовка МДФ».
if ("pf", "Заготовка МДФ") not in types and ("pf", "Панель щитовая") in types:
    old = types.pop(("pf", "Панель щитовая"))
    types[("pf", "Заготовка МДФ")] = ok(c.put(f"/api/item-types/{old['id']}", json={"name": "Заготовка МДФ"}), "rename raw")
    print("тип переименован: Панель щитовая → Заготовка МДФ")
size3 = [num("толщина", "Толщина"), num("ширина", "Ширина"), num("высота", "Высота")]
color = {"code": "цвет", "name": "Цвет", "value_type": "text", "is_required": True}
series_text = {"code": "серия", "name": "Серия", "value_type": "text", "is_required": True}
raw = ensure_type("pf", "Заготовка МДФ", size3, "Заготовка МДФ {толщина}х{ширина}х{высота}")
lam = ensure_type(
    "pf", "Панель щитовая ламинированная", [*size3, color], "Панель щитовой двери {толщина}х{ширина}х{высота} ({цвет})"
)
milled = ensure_type(
    "pf", "Панель щитовая фрезерованная", [series_text, *size3],
    "{серия} Панель щитовой двери {толщина}х{ширина}х{высота} (фрезерованная)",
)
patterned = ensure_type(
    "pf", "Панель щитовая с узором",
    [series_text, *size3, color, {"code": "пэт", "name": "Плёнка ПЭТ (сначала ламинация)", "value_type": "bool"}],
    "{серия} Панель щитовой двери {толщина}х{ширина}х{высота} ({цвет})",
)
door = ensure_type(
    "izdelie", "Щитовая дверь",
    [
        {"code": "серия", "name": "Серия", "value_type": "list", "is_required": True, "option_fields": [
            {"code": "толщина_каркаса", "name": "Толщина каркаса, мм", "value_type": "number"},
            {"code": "толщина_панели", "name": "Толщина панели, мм", "value_type": "number"},
            {"code": "кромка", "name": "Кромка (abs / aluminum)", "value_type": "text"},
        ]},
        num("ширина", "Ширина"), num("высота", "Высота"),
        {"code": "цвет", "name": "Цвет", "value_type": "text", "is_required": True},
        # Вид стекла («Черное», «Зеркало ГРАФИТ»); пусто — без стекла.
        {"code": "стекло", "name": "Стекло", "value_type": "text"},
        {"code": "молдинг", "name": "Молдинг", "value_type": "bool"},
        {"code": "замок", "name": "Фрезеровка под замок", "value_type": "bool"},
        # Кромка двери — обычно как у серии, но в графике бывает другой
        # (В-16.2 с алюминиевым профилем): разбор графика берёт её из строки.
        {"code": "кромка", "name": "Кромка", "value_type": "list", "is_required": True},
        # Цвет и материал кромки как в 1С: «черная ABS 2мм», «ПЭТ Белая 1мм».
        {"code": "цвет_кромки", "name": "Цвет кромки", "value_type": "text"},
    ],
    'Дверь щитовая {серия} {ширина}х{высота} {цвет}{" с молдингом" if молдинг else ""}{" под замок" if замок else ""}'
    '{", стекло " + стекло if стекло else ""}{", кромка " + цвет_кромки if цвет_кромки else ""}'
    '{" (алюм. профиль)" if not цвет_кромки and кромка == "aluminum" and серия.кромка != "aluminum" else ""}'
    '{" (кромка ABS)" if not цвет_кромки and кромка == "abs" and серия.кромка != "abs" else ""}',
)
# Стекло было галочкой — теперь вид стекла (текст). Менять можно, пока свойство
# не заполнено ни у одной позиции.
glass = next(p for p in door["properties"] if p["code"] == "стекло")
if glass["value_type"] == "bool":
    ok(c.put(f"/api/item-properties/{glass['id']}", json={
        "code": "стекло", "name": "Стекло", "value_type": "text", "is_required": False, "option_fields": [],
    }), "glass → text")
    print("свойство «Стекло»: галочка → вид стекла")
# Модель — серия: «Щитовая дверь В-9», размеры, цвета… — её варианты.
door = ok(c.put(f"/api/item-types/{door['id']}", json={"model_property_code": "серия"}), "door model property")
edge_prop = next(p for p in door["properties"] if p["code"] == "кромка")
if not edge_prop["options"]:
    ok(c.put(f"/api/item-properties/{edge_prop['id']}/options", json=[
        {"value": "abs", "params": {}, "is_active": True},
        {"value": "aluminum", "params": {}, "is_active": True},
    ]), "edge options")

# --- серии: из справочника серий щитовых дверей ---
series_prop = next(p for p in door["properties"] if p["code"] == "серия")
existing = {o["value"]: o for o in series_prop["options"]}
rows = db.execute(text("select name, frame_thickness_mm, panel_mdf_thickness_mm, edge_type, is_active from door_series order by name")).all()
options = [
    {"id": existing[r[0]]["id"] if r[0] in existing else None, "value": r[0], "is_active": bool(r[4]),
     "params": {"толщина_каркаса": float(r[1]), "толщина_панели": float(r[2]), "кромка": r[3]}}
    for r in rows
]
ok(c.put(f"/api/item-properties/{series_prop['id']}/options", json=options), "series")
print("серий:", len(options))

# --- маршруты и правила ---
READY = None  # «Готово» без участка — общий запас, с любого участка
SIZE = {"толщина": "толщина", "ширина": "ширина", "высота": "высота"}
DIMS = {"width_expr": "ширина", "length_expr": "высота"}  # размеры детали-компонента, мм
ok(c.put(f"/api/item-types/{raw['id']}/operations", json=[
    {"name": "Распил", "area": A["Распил панелей"]},
    {"name": "Готово", "area": READY},
]), "raw ops")
ok(c.put(f"/api/item-types/{raw['id']}/component-rules", json=[]), "raw rules")
ok(c.put(f"/api/item-types/{lam['id']}/operations", json=[
    {"name": "Шлифовка", "area": A["Шлифовка панелей"]},
    {"name": "Ламинация", "area": LAMINATION_AREA},
    {"name": "Готово", "area": READY},  # дальше — на склейку (гладкая) или на фрезеровку (ПЭТ с узором)
]), "lam ops")
ok(c.put(f"/api/item-types/{lam['id']}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "operation_name": "Шлифовка", "component_type_id": raw["id"], "component_values": SIZE, **DIMS},
]), "lam rules")
ok(c.put(f"/api/item-types/{milled['id']}/operations", json=[
    {"name": "Фрезеровка", "area": A["Фрезеровка панелей"]},
    {"name": "Шлифовка", "area": A["Шлифовка панелей"]},
    {"name": "Готова к ламинации", "area": LAMINATION_AREA},
]), "milled ops")
ok(c.put(f"/api/item-types/{milled['id']}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "operation_name": "Фрезеровка", "component_type_id": raw["id"], "component_values": SIZE, **DIMS},
]), "milled rules")
ok(c.put(f"/api/item-types/{patterned['id']}/operations", json=[
    {"name": "Ламинация", "area": LAMINATION_AREA, "condition": "not пэт"},
    {"name": "Фрезеровка", "area": A["Фрезеровка панелей"], "condition": "пэт"},
    {"name": "Готова к склейке", "area": A["Склейка щитов"]},
]), "patterned ops")
ok(c.put(f"/api/item-types/{patterned['id']}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "condition": "not пэт", "operation_name": "Ламинация",
     "component_type_id": milled["id"], "component_values": {"серия": "серия", **SIZE}, **DIMS},
    {"name_template": "", "qty_expr": "1", "condition": "пэт", "operation_name": "Фрезеровка",
     "component_type_id": lam["id"], "component_values": {**SIZE, "цвет": "цвет"}, **DIMS},
]), "patterned rules")

ok(c.put(f"/api/item-types/{frame['id']}/operations", json=[
    {"name": "Сборка каркаса", "area": A["Сборка каркасов"]},
    {"name": "Готов к склейке", "area": A["Склейка щитов"]},
]), "frame ops")


def piece(name, qty, w, length):
    """Деталь каркаса по спецификациям 1С (каркас = дверь + 10 мм)."""
    return {"name_template": name, "qty_expr": qty, "width_expr": w, "length_expr": length, "operation_name": "Сборка каркаса"}


ok(c.put(f"/api/item-types/{frame['id']}/component-rules", json=[
    piece("Стойка каркаса {толщина}х50х{высота}", "2", "50", "высота"),
    piece("Поперечная каркаса {толщина}х50х{ширина - 102}", "2", "50", "ширина - 102"),
    piece("Усилитель каркаса {толщина}х16х{высота - 102}", "1 if ширина <= 610 else 2", "16", "высота - 102"),
    piece("Вставка замковая каркаса {толщина}х50х300", "2", "50", "300"),
]), "frame rules")

ok(c.put(f"/api/item-types/{door['id']}/operations", json=[
    {"name": "Склейка щитов", "area": A["Склейка щитов"]},
    {"name": "Фрезеровка периметра", "area": A["Фрезеровка периметра щитов"]},
    {"name": "Сборка", "area": A["Сборка щитовых дверей"]},
    {"name": "Кромка", "area": A["Кромка щитовых дверей"], "condition": 'кромка == "abs"'},
    {"name": "Фрезеровка под замок", "area": A["Фрезеровка под замок"], "condition": "замок"},
    {"name": "Упаковка", "area": A["Упаковка щитовых дверей"]},
]), "door ops")
PANEL = {"толщина": "серия.толщина_панели", "ширина": "ширина + 10", "высота": "высота + 10"}
PANEL_DIMS = {"width_expr": "ширина + 10", "length_expr": "высота + 10"}


def foam(w, qty):
    """Пенопласт на склейку щита — по таблице ширин из спецификаций 1С."""
    return {
        "name_template": "Пенопласт {серия.толщина_каркаса - 1}х" + str(w) + "х{высота - 100}", "qty_expr": qty,
        "width_expr": str(w), "length_expr": "высота - 100", "operation_name": "Склейка щитов",
    }


ok(c.put(f"/api/item-types/{door['id']}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "width_expr": "ширина + 10", "length_expr": "высота + 10",
     "operation_name": "Склейка щитов", "component_type_id": frame["id"],
     "component_values": {"ширина": "ширина + 10", "высота": "высота + 10", "толщина": "серия.толщина_каркаса"}},
    # Гладкая панель — общая для всех серий; с молдингом — панель с узором серии.
    {"name_template": "", "qty_expr": "2", "condition": "not молдинг", "operation_name": "Склейка щитов",
     "component_type_id": lam["id"], "component_values": {**PANEL, "цвет": "цвет"}, **PANEL_DIMS},
    {"name_template": "", "qty_expr": "2", "condition": "молдинг", "operation_name": "Склейка щитов",
     "component_type_id": patterned["id"],
     "component_values": {"серия": "серия", **PANEL, "цвет": "цвет", "пэт": '"ПЭТ" in цвет or "пэт" in цвет'},
     **PANEL_DIMS},
    foam(200, "2 if ширина in (600, 900, 1000) else 0"),
    foam(150, "3 if ширина == 700 else (2 if ширина == 800 else 0)"),
    foam(250, "1 if ширина >= 800 else 0"),
]), "door rules")
print("маршруты и правила заданы")

# --- черновик деталей — в архив (партий нет) ---
drafts = db.execute(text(
    "select p.id, p.name from parts p where p.is_active and (p.name like 'Панель щитовой двери %' or p.name like 'Заготовка для щита %') "
    "and not exists (select 1 from part_units u where u.part_id = p.id)"
)).all()
for pid, name in drafts:
    db.execute(text("update parts set is_active = false where id = :id"), {"id": pid})
db.commit()
print("в архив:", [n for _, n in drafts])
