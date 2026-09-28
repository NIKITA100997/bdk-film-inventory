"""Щитовые двери: старые модели BOM — в архив, модели — по всем сериям
(решение пользователя 28.09.2026).

Старые «Модели продукции (BOM)» щитовых (участок «Щитовые двери»: «А-1,
600×2000», «В-10.1, 700×2000»…) заведены из спецификаций до единой
модели — без типа, маршрута и объединения по модели, в составе только
панели; всё это уже покрыто правилами типа «Щитовая дверь». Модель («Щитовая
дверь В-11») раньше появлялась только с первым вариантом — теперь заводится
на каждую серию справочника, варианты к ней — мастером «+ Добавить
варианты».

Повторяемо: уже сделанное пропускается. Запуск из backend/:
    .venv/Scripts/python.exe scripts/setup_shield_models.py          # проверка, без записи
    .venv/Scripts/python.exe scripts/setup_shield_models.py --apply  # записать"""

import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import Item, ItemType  # noqa: E402
from app.models.production import ProductModel, ProductionTask  # noqa: E402
from app.models.production_orders import ProductionOrderLine  # noqa: E402
from app.services.model_builder import ensure_model  # noqa: E402

OLD_AREA = "shchitovye_dveri"
TYPE_NAME = "Щитовая дверь"

apply = "--apply" in sys.argv
db = SessionLocal()

# --- старые модели BOM щитовых → архив ---
old = db.query(ProductModel).filter(ProductModel.area == OLD_AREA).order_by(ProductModel.name).all()
used = {
    pm.id
    for pm in old
    if db.query(ProductionTask.id).filter(ProductionTask.product_model_id == pm.id).first()
    or (pm.item_id and db.query(ProductionOrderLine.id).filter(ProductionOrderLine.item_id == pm.item_id).first())
}
to_archive = [pm for pm in old if pm.is_active and pm.id not in used]
print(f"Старых моделей BOM щитовых: {len(old)}, в архив: {len(to_archive)}, используются (не трогаем): {len(used)}")
for pm in to_archive:
    pm.is_active = False
    item = db.get(Item, pm.item_id) if pm.item_id else None
    if item is not None:
        item.is_active = False
    print(f"  в архив: {pm.name}")

# --- модели по всем сериям ---
t = db.query(ItemType).filter(ItemType.name == TYPE_NAME).one()
prop = next(p for p in t.properties if p.id == t.model_property_id)
before = {i.id for i in db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(True))}
for opt in sorted(prop.options, key=lambda o: o.sort_order):
    if not opt.is_active:
        continue
    model = ensure_model(db, t, opt)
    if model.id not in before:
        print(f"  модель: {model.name}")
created = db.query(Item).filter(Item.type_id == t.id, Item.is_model.is_(True)).count() - len(before)
print(f"Моделей «{TYPE_NAME}»: было {len(before)}, новых {created}")

if apply:
    db.commit()
    print("Записано.")
else:
    db.rollback()
    print("Проверка — ничего не записано (запуск с --apply запишет).")
