"""Варианты щитовых дверей по названиям спецификаций 1С (25.09.2026).

Вход — текстовый файл, по названию спецификации на строку, как в 1С:
    В-9 кромка с 4-х сторон 600х2000 - ПЭТ Светло-серый (gray silk) (стекло Зеркало ГРАФИТ) кромка черная ABS 2мм
Строка разбирается так же, как строка графика (services/schedule_import.py):
серия — первое слово, размер, цвет — после « - » до кромки (без «(стекло …)»),
стекло, кромка, молдинг — из названия. Вариант находится или заводится по
типу «Щитовая дверь» (техкарта — по правилам типа) и встаёт под свою модель.

Запуск из backend/:
    .venv/Scripts/python.exe scripts/import_shield_specs.py specs.txt [--dry-run]"""

import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, ".")

from app.db.session import SessionLocal  # noqa: E402
from app.models.items import ItemType  # noqa: E402
from app.services import type_rules  # noqa: E402
from app.services.schedule_import import _values_for_row  # noqa: E402
from app.services.shield_schedule import ScheduleRow  # noqa: E402

DRY = "--dry-run" in sys.argv
path = next(a for a in sys.argv[1:] if not a.startswith("--"))
titles = [" ".join(x.split()) for x in open(path, encoding="utf-8") if x.strip()]

db = SessionLocal()
door = db.query(ItemType).filter(ItemType.name == "Щитовая дверь").one()
created = existed = 0
failed = []
for title in dict.fromkeys(titles):  # повторы — один раз
    size = re.search(r"(\d{3,4})\s*[хx]\s*(\d{4})", title)
    head, _, rest = title.partition(" - ")
    color = re.sub(r"\s*\(стекло[^)]*\)", "", re.split(r"\s+кромка\s+", rest)[0]).strip()
    row = ScheduleRow(
        ship_date=None, invoice_no="", series_text=head.split()[0], size_text=f"{size[1]}х{size[2]}" if size else "",
        color_text=color, name_text=title, doors_qty=1,
    )
    values, errors = _values_for_row(door, row)
    if not errors:
        sp = db.begin_nested()
        item, is_new, errors = type_rules.ensure_item(db, door, values)
        if errors:
            sp.rollback()
        else:
            sp.commit()
            created += is_new
            existed += not is_new
            print(("+ " if is_new else "= ") + item.name)
    if errors:
        failed.append((title, errors))
for title, errors in failed:
    print("ОШИБКА:", title, "—", "; ".join(errors))
print(f"заведено: {created}, уже были: {existed}, ошибок: {len(failed)}")
if DRY or failed:
    db.rollback()
    print("ничего не записано" + (" (пробный прогон)" if DRY else " — есть ошибки"))
else:
    db.commit()
