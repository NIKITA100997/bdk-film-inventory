"""Тип «Царговая дверь» на единой модели (25.09.2026) — только данные:
тип номенклатуры вида «Изделие» со свойствами (серия, ширина, высота) и
назначение его уже заведённым царговым моделям BOM («М-1, 600×2000»).

Серии и их параметры (сколько филёнок, ширина филёнки, сколько планок) —
из строк BOM самих моделей. Маршрут и правила состава типу не задаются:
окутка царговых по-прежнему идёт по BOM моделей, ничего в работе не
меняется.

Повторяемо: уже заведённое пропускается. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_tsarg_doors.py"""

import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.security import get_current_user  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.production import ProductModel  # noqa: E402
from app.models.users import User  # noqa: E402

TSARG_AREA = "okutka_tsargovykh"
NAME_RE = re.compile(r"^(?P<series>[^,]+),\s*(?P<w>\d+)\s*[×х]\s*(?P<h>\d+)$")

db = SessionLocal()
admin = db.query(User).filter(User.is_superuser.is_(True), User.is_active.is_(True)).order_by(User.id).first()
app.dependency_overrides[get_current_user] = lambda: admin
c = TestClient(app)


def ok(r, what):
    if r.status_code >= 300:
        raise SystemExit(f"{what}: {r.status_code} {r.text}")
    return r.json()


# --- модели и серии из BOM ---
models = (
    db.query(ProductModel)
    .filter(ProductModel.area == TSARG_AREA, ProductModel.is_trim.is_(False), ProductModel.item_id.isnot(None))
    .order_by(ProductModel.name)
    .all()
)
parsed = []
series: dict[str, dict] = {}
for m in models:
    mt = NAME_RE.match(m.name.strip())
    if not mt:
        print("пропущена (название не «Серия, Ш×В»):", m.name)
        continue
    s = mt["series"].strip()
    parsed.append((m, s, int(mt["w"]), int(mt["h"])))
    panels = [p for p in m.parts if (p.part_name or "").startswith("Филёнка")]
    series.setdefault(s, {
        "филёнок": float(sum(p.qty_per_unit for p in panels)),
        "ширина_филёнки": float(panels[0].width_mm) if panels else 0.0,
        "планок": float(sum(p.qty_per_unit for p in m.parts if (p.part_name or "").startswith("Планка"))),
    })
print("моделей:", len(parsed), "серий:", len(series))

# --- тип ---
t = next((x for x in ok(c.get("/api/item-types"), "types") if x["kind_code"] == "izdelie" and x["name"] == "Царговая дверь"), None)
if t is None:
    t = ok(c.post("/api/item-types", json={"kind_code": "izdelie", "name": "Царговая дверь"}), "type")
    print("тип создан")
have = {p["code"] for p in t["properties"]}
for p in [
    {"code": "серия", "name": "Серия", "value_type": "list", "is_required": True, "option_fields": [
        {"code": "филёнок", "name": "Филёнок, шт", "value_type": "number"},
        {"code": "ширина_филёнки", "name": "Ширина филёнки, мм", "value_type": "number"},
        {"code": "планок", "name": "Планок, шт", "value_type": "number"},
    ]},
    {"code": "ширина", "name": "Ширина", "value_type": "number", "unit": "мм", "is_required": True},
    {"code": "высота", "name": "Высота", "value_type": "number", "unit": "мм", "is_required": True},
]:
    if p["code"] not in have:
        ok(c.post(f"/api/item-types/{t['id']}/properties", json=p), f"prop {p['name']}")
# Как у моделей BOM: «М-1, 600×2000».
ok(c.put(f"/api/item-types/{t['id']}", json={"name_template": "{серия}, {ширина}×{высота}"}), "template")
t = next(x for x in ok(c.get("/api/item-types"), "types") if x["id"] == t["id"])
P = {p["code"]: p for p in t["properties"]}

existing = {o["value"]: o for o in P["серия"]["options"]}
opts = [
    {"id": existing[s]["id"] if s in existing else None, "value": s, "is_active": True, "params": params}
    for s, params in sorted(series.items())
]
opts += [o for v, o in existing.items() if v not in series]  # заведённые вручную — не трогаем
P["серия"] = ok(c.put(f"/api/item-properties/{P['серия']['id']}/options", json=opts), "series")
opt_id = {o["value"]: o["id"] for o in P["серия"]["options"]}

# --- назначить тип моделям ---
done = 0
for m, s, w, h in parsed:
    cur = ok(c.get(f"/api/items/{m.item_id}/properties"), "props")
    values = {str(P["серия"]["id"]): opt_id[s], str(P["ширина"]["id"]): w, str(P["высота"]["id"]): h}
    if cur["type_id"] == t["id"] and {str(k): v for k, v in cur["values"].items()} == values:
        continue
    r = ok(c.put(f"/api/items/{m.item_id}/properties", json={"type_id": t["id"], "values": values}), f"assign {m.name}")
    if r.get("rules_errors"):
        raise SystemExit(f"{m.name}: {r['rules_errors']}")
    done += 1
print("назначено моделям:", done)
