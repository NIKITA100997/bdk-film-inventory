"""Цены у старых рулонов и суммы у старых движений плёнки (08.10.2026,
учёт по количеству и сумме, шаг 1а).

Рулон без родителя — цена м² на дату прихода (services/lot_cost.film_price_at:
цена позиции → заявка поставщику → ближайшая более поздняя как «оценка»);
кусок — цена родителя; движение — Δм × ширина × цена м² рулона.
Материалы — по порядку движений: приход по цене позиции на дату, расход,
списание и инвентаризация по средней цене остатка на тот момент.
Уже проставленное не трогает. Без --apply только показывает итог.

    .venv\\Scripts\\python scripts\\backfill_lot_prices.py [--apply]
"""

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401
from app.db.session import SessionLocal  # noqa: E402
from app.models.dictionaries import MaterialSku  # noqa: E402
from app.models.events import MaterialEvent  # noqa: E402
from app.models.units import MaterialUnit, UnitStatus  # noqa: E402
from app.models.items import MOVE_RECEIPT, Item, MaterialMove  # noqa: E402
from app.services.lot_cost import event_amount, film_price_at, material_list_price, unit_value  # noqa: E402


def main() -> None:
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        units = db.query(MaterialUnit).order_by(MaterialUnit.id).all()
        by_id = {u.id: u for u in units}
        skus = {s.id: s for s in db.query(MaterialSku)}
        src = Counter()
        no_price: Counter = Counter()

        def price_of(u: MaterialUnit):
            if u.price_per_m2 is not None:
                return u.price_per_m2, u.price_source
            parent = by_id.get(u.parent_id) if u.parent_id else None
            if parent is not None:
                p = price_of(parent)
                u.price_per_m2, u.price_source = p
                return p
            sku = skus.get(u.material_sku_id)
            p = film_price_at(db, sku, u.created_at.date())
            u.price_per_m2, u.price_source = p
            return p

        for u in units:
            had = u.price_per_m2 is not None
            p, s = price_of(u)
            if not had:
                src[s or "нет цены"] += 1
                if p is None:
                    sku = skus.get(u.material_sku_id)
                    no_price[f"{sku.material.name} {sku.color.name} {float(sku.thickness.value_mm):g}" if sku else "?"] += 1
        ev_done = ev_none = 0
        for e in db.query(MaterialEvent).filter(MaterialEvent.amount_rub.is_(None)):
            u = by_id.get(e.unit_id)
            amt = event_amount(e.quantity_delta_m, e.width_mm, u.price_per_m2) if u else None
            if amt is None:
                ev_none += 1
                continue
            e.amount_rub = amt
            ev_done += 1
        # материалы — скользящая средняя по порядку движений
        run: dict[int, list[float]] = {}  # позиция → [сумма, количество] по движениям с ценой
        items = {i.id: i for i in db.query(Item).filter(Item.id.in_({m.item_id for m in db.query(MaterialMove.item_id)}))}
        mat_done = mat_none = 0
        for m in db.query(MaterialMove).order_by(MaterialMove.occurred_at, MaterialMove.id):
            acc = run.setdefault(m.item_id, [0.0, 0.0])
            if m.amount_rub is None:
                avg = acc[0] / acc[1] if acc[1] > 1e-9 and acc[0] >= 0 else None
                listp = material_list_price(db, items[m.item_id], m.occurred_at.date())
                price = (listp or avg) if m.kind == MOVE_RECEIPT else (avg or listp)
                if price is None:
                    mat_none += 1
                    continue
                m.price_rub, m.amount_rub = round(price, 4), round(float(m.qty) * price, 2)
                mat_done += 1
            acc[0] += float(m.amount_rub)
            acc[1] += float(m.qty)
        print(f"Движений материалов: суммы проставлены {mat_done}, без цены {mat_none}")
        live = [u for u in units if u.status != UnitStatus.SPISAN]
        total = sum(unit_value(u) or 0 for u in live)
        priced = sum(1 for u in live if u.price_per_m2 is not None)
        print(f"Рулонов и штрипсов: {len(units)}; цена проставлена: {dict(src)}")
        print(f"Движений: суммы проставлены {ev_done}, без цены {ev_none}")
        money = f"{total:,.0f}".replace(",", " ")
        print(f"На складе и участках: {len(live)} ед., с ценой {priced}, стоимость {money} ₽")
        if no_price:
            print(f"Без цены — групп {len(no_price)}:")
            for k, v in no_price.most_common(20):
                print(f"  {v:4}  {k}")
        if apply:
            db.commit()
            print("Записано.")
        else:
            db.rollback()
            print("Проверка. Для записи добавьте --apply")
    finally:
        db.close()


if __name__ == "__main__":
    main()
