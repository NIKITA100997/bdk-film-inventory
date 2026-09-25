"""Типы п/ф МК и панелей (25.09.2026) — конфигуратор, как у щитовых.

«Заготовка п/ф» и «Деталь МК/панели» со свойствами (линия, профиль, размеры,
исполнение) и правилами: у детали маршрут «Фрезеровка → Окутка» и на
фрезеровке — заготовка того же размера (МДФ в исполнении — заготовка из
МДФ); у заготовки — «Склейка МДФ с заготовкой → Готово (общий запас)».
Новая деталь, заведённая по типу («Новая позиция»), получает маршрут и
заготовку сама.

Существующие заготовки и детали (подгруппы «Заготовки»/«Детали» в МК и
Панелях) получают тип и свойства по разбору названия. Название, собранное
по шаблону, обязано совпасть с нынешним — иначе позиция не трогается и
выводится списком. Ручная связь «деталь → заготовка» (setup_pf_blanks.py)
заменяется связью по правилу типа, партии не трогаются.

Повторяемо. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_pf_types.py [--dry-run]"""

import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.security import get_current_user  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.dictionaries import Part  # noqa: E402
from app.models.items import Item, ItemComponent, ItemGroup, ItemType, normalize_name  # noqa: E402
from app.models.users import User  # noqa: E402
from app.services import type_rules  # noqa: E402

DRY = "--dry-run" in sys.argv
GLUE_AREA, WRAP_AREA = "skleyka_mdf_s_zagotovkoy", "okutka_tsargovykh"
LINES = {"МК": "МК", "Панели (металлические двери)": "Панели"}
NAME_RE = re.compile(r"^(?P<profile>.+?)\s+(?P<t>\d+)х(?P<w>\d+)х(?P<l>\d+)(?:\s+(?P<rest>.+))?$")
BLANK_RE = re.compile(r"^Заготовка (?P<line>МК|\(Панель\)) (?P<t>\d+)х(?P<w>\d+)х(?P<l>\d+)(?: (?P<mat>МДФ))?$")

db = SessionLocal()
admin = db.query(User).filter(User.is_superuser.is_(True), User.is_active.is_(True)).order_by(User.id).first()
app.dependency_overrides[get_current_user] = lambda: admin
c = TestClient(app)


def ok(r, what):
    if r.status_code >= 300:
        raise SystemExit(f"{what}: {r.status_code} {r.text}")
    return r.json()


types = {(t["kind_code"], t["name"]): t for t in ok(c.get("/api/item-types"), "types")}


def ensure_type(name, props, template):
    t = types.get(("pf", name))
    if t is None:
        t = ok(c.post("/api/item-types", json={"kind_code": "pf", "name": name}), f"type {name}")
        print("тип создан:", name)
    have = {p["code"] for p in t["properties"]}
    for p in props:
        if p["code"] not in have:
            ok(c.post(f"/api/item-types/{t['id']}/properties", json=p), f"prop {p['name']}")
    ok(c.put(f"/api/item-types/{t['id']}", json={"name_template": template}), f"template {name}")
    t = next(x for x in ok(c.get("/api/item-types"), "types") if x["id"] == t["id"])
    line = next(p for p in t["properties"] if p["code"] == "линия")
    if not line["options"]:
        ok(c.put(f"/api/item-properties/{line['id']}/options", json=[
            {"value": "МК", "params": {}, "is_active": True}, {"value": "Панели", "params": {}, "is_active": True},
        ]), "line options")
    return next(x for x in ok(c.get("/api/item-types"), "types") if x["id"] == t["id"])


num = lambda code, name: {"code": code, "name": name, "value_type": "number", "unit": "мм", "is_required": True}  # noqa: E731
line_prop = {"code": "линия", "name": "Линия", "value_type": "list", "is_required": True}
size = [num("толщина", "Толщина"), num("ширина", "Ширина"), num("длина", "Длина")]

blank_t = ensure_type(
    "Заготовка п/ф",
    [line_prop, *size, {"code": "материал", "name": "Материал (МДФ — цельный МДФ)", "value_type": "text"}],
    '{"Заготовка " + ("(Панель)" if линия == "Панели" else "МК")} {толщина}х{ширина}х{длина}{" " + материал if материал else ""}',
)
detail_t = ensure_type(
    "Деталь МК/панели",
    [line_prop, {"code": "профиль", "name": "Профиль (как в названии)", "value_type": "text", "is_required": True}, *size,
     {"code": "исполнение", "name": "Исполнение (паз, МДФ, «под 16мм»…)", "value_type": "text"}],
    '{профиль} {толщина}х{ширина}х{длина}{" " + исполнение if исполнение else ""}',
)
ok(c.put(f"/api/item-types/{blank_t['id']}/operations", json=[
    {"name": "Склейка МДФ с заготовкой", "area": GLUE_AREA},
    {"name": "Готово", "area": None},  # общий запас — на фрезеровку любой детали этого размера
]), "blank ops")
ok(c.put(f"/api/item-types/{detail_t['id']}/operations", json=[
    {"name": "Фрезеровка", "area": GLUE_AREA},
    {"name": "Окутка", "area": WRAP_AREA},
]), "detail ops")
ok(c.put(f"/api/item-types/{detail_t['id']}/component-rules", json=[
    {"name_template": "", "qty_expr": "1", "operation_name": "Фрезеровка", "component_type_id": blank_t["id"],
     "width_expr": "ширина", "length_expr": "длина",
     "component_values": {"линия": "линия", "толщина": "толщина", "ширина": "ширина", "длина": "длина",
                          "материал": '"МДФ" if "МДФ" in исполнение else ""'}},
]), "detail rules")
blank_type, detail_type = db.get(ItemType, blank_t["id"]), db.get(ItemType, detail_t["id"])
db.expire_all()
BP = {p.code: p for p in blank_type.properties}
DP = {p.code: p for p in detail_type.properties}
line_opt = {o.value: o.id for o in BP["линия"].options}
dline_opt = {o.value: o.id for o in DP["линия"].options}

# --- существующие позиции ---
tops = {g.id: LINES[g.name] for g in db.query(ItemGroup).filter(ItemGroup.name.in_(LINES), ItemGroup.parent_id.is_(None))}
subs = {g.id: (tops[g.parent_id], g.name) for g in db.query(ItemGroup).filter(ItemGroup.parent_id.in_(tops))}
parts_before = db.query(Part).count()
done, same, skipped = {"Заготовки": 0, "Детали": 0}, 0, []
rows = (
    db.query(Part, Item).join(Item, Item.id == Part.item_id).filter(Item.group_id.in_(subs)).order_by(Part.name).all()
)
for is_blank_pass in (True, False):  # сначала заготовки — детали ссылаются на них по правилу
    for part, item in rows:
        line, sub = subs[item.group_id]
        if (sub == "Заготовки") != is_blank_pass:
            continue
        if sub == "Заготовки":
            m = BLANK_RE.match(part.name)
            if not m:
                skipped.append(f"{part.name}: название не разобрано")
                continue
            t, values = blank_type, {
                BP["линия"].id: line_opt["Панели" if m["line"] == "(Панель)" else "МК"], BP["толщина"].id: float(m["t"]),
                BP["ширина"].id: float(m["w"]), BP["длина"].id: float(m["l"]),
            }
            if m["mat"]:
                values[BP["материал"].id] = m["mat"]
        else:
            m = NAME_RE.match(part.name)
            if not m:
                skipped.append(f"{part.name}: название не разобрано")
                continue
            t, values = detail_type, {
                DP["линия"].id: dline_opt[line], DP["профиль"].id: m["profile"], DP["толщина"].id: float(m["t"]),
                DP["ширина"].id: float(m["w"]), DP["длина"].id: float(m["l"]),
            }
            if m["rest"]:
                values[DP["исполнение"].id] = m["rest"]
        filled = lambda d: {k: v for k, v in d.items() if v not in (None, "")}  # noqa: E731
        if item.type_id == t.id and filled(type_rules.item_values(db, item)) == filled(values):
            same += 1
            continue
        res = type_rules.compute(db, t, type_rules.context_from_values(db, t, values))
        if res.errors or normalize_name(res.name or "") != normalize_name(part.name):
            skipped.append(f"{part.name}: по шаблону выходит «{res.name}» {res.errors or ''}")
            continue
        sp = db.begin_nested()
        # Ручная связь со своей заготовкой — заменит правило типа.
        db.query(ItemComponent).filter(ItemComponent.parent_item_id == item.id, ItemComponent.source == "manual").delete()
        type_rules._set_values(db, item, t, values)
        applied = type_rules.apply(db, item)
        if applied.errors:
            sp.rollback()
            skipped.append(f"{part.name}: {applied.errors}")
            continue
        sp.commit()
        done[sub] += 1

created = db.query(Part).count() - parts_before
print(f"типизировано: заготовок {done['Заготовки']}, деталей {done['Детали']}; уже были: {same}; новых деталей п/ф: {created}")
if skipped:
    print("не тронуты:", *skipped, sep="\n  ")
if created:
    print("ВНИМАНИЕ: правила завели новые детали — заготовка по правилу не совпала с существующей")
if DRY or created:
    db.rollback()
    print("ничего не записано" + (" (пробный прогон)" if DRY else ""))
else:
    db.commit()
