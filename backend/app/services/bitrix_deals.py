"""Сделки Битрикс24 у заказов клиентов (14.10).

Заказ клиента = счёт 1С; сделку менеджер обычно заводит в Битриксе раньше,
её название начинается с номера счёта («2101-ЭЛ(М) щиты, 75шт»). Поэтому:

- при отправке заказа производству (и в фоне для принятых без сделки)
  программа ищет сделку по номеру счёта в выбранной воронке: одна —
  привязывает; ни одной — создаёт (если включено «создавать»); несколько —
  ждёт, пока выберут вручную в карточке заказа;
- сделка идёт по стадиям за заказом — только вперёд и не из закрытых:
  принят → в производстве → на складе ГП → отгрузка (какие стадии воронки —
  в настройках Битрикса); обещанная отгрузка — в поле даты отгрузки;
- в ленту сделки — принятие, возврат, переносы дат с причиной, отмена.

Настройки (app_settings "bitrix"): deals_enabled, deal_category,
deal_auto_create, deal_stage_accepted / _production / _ready / _shipping,
deal_ship_field."""

import logging
import re
import threading
from datetime import date

from sqlalchemy.orm import Session

from app.models.customer_orders import CustomerOrder
from app.models.users import User
from app.services import bitrix as bx

log = logging.getLogger(__name__)

# стадия заказа → ключ настройки со стадией сделки
STAGE_KEYS = {
    "accepted": "deal_stage_accepted",
    "assembled": "deal_stage_accepted",
    "in_production": "deal_stage_production",
    "ready": "deal_stage_ready",
    "shipped_part": "deal_stage_shipping",
    "shipped": "deal_stage_shipping",
}
CLOSED_SUFFIXES = ("WON", "LOSE", "APOLOGY")


def enabled(s: dict) -> bool:
    return bool(s.get("enabled") and s.get("webhook") and s.get("deals_enabled") and s.get("deal_category") is not None)


def portal(s: dict) -> str:
    m = re.match(r"(https://[^/]+)/", s.get("webhook") or "")
    return m.group(1) if m else ""


def deal_url(s: dict, deal_id: int | None) -> str | None:
    return f"{portal(s)}/crm/deal/details/{deal_id}/" if deal_id and portal(s) else None


def _norm(t: str) -> str:
    return re.sub(r"[^0-9a-zа-яё]", "", (t or "").lower().replace("ё", "е"))


def title_matches(title: str, invoice: str) -> bool:
    """Название сделки начинается с номера счёта: «2101-ЭЛ(М) щиты…» ↔ 2101-ЭЛ,
    «1157 ЛД инвизибл» ↔ 1157-ЛД; «21010-…» — другой счёт."""
    t, inv = _norm(title), _norm(invoice)
    t = re.sub(r"^ат", "", t) if not inv.startswith("ат") else t  # «АТ №271 …»
    if not inv or not t.startswith(inv):
        return False
    rest = t[len(inv):]
    return not (rest[:1].isdigit() and inv[-1:].isdigit())


def find_deals(s: dict, invoice: str) -> list[dict]:
    num = re.match(r"\s*(\d+)", invoice or "")
    if not num:
        return []
    data = bx.call(s["webhook"], "crm.deal.list", {
        "filter": {"CATEGORY_ID": s["deal_category"], "%TITLE": num.group(1)},
        "select": ["ID", "TITLE", "STAGE_ID", "OPPORTUNITY", "ASSIGNED_BY_ID", "DATE_CREATE"],
        "order": {"ID": "DESC"},
    })
    return [d for d in data.get("result", []) if title_matches(d.get("TITLE", ""), invoice)]


def stages(s: dict) -> list[str]:
    cat = int(s["deal_category"])
    entity = "DEAL_STAGE" if cat == 0 else f"DEAL_STAGE_{cat}"
    data = bx.call(s["webhook"], "crm.status.list", {"filter": {"ENTITY_ID": entity}, "order": {"SORT": "ASC"}})
    return [x["STATUS_ID"] for x in data.get("result", [])]


def _manager_bx(db: Session, co: CustomerOrder) -> int | None:
    u = db.get(User, co.manager_id or co.created_by)
    return u.bitrix_user_id if u is not None else None


def create_deal(db: Session, s: dict, co: CustomerOrder) -> int:
    from app.services.customer_orders import progress
    from app.services.components import live_item_names

    p = progress(db, co)
    names = live_item_names(db, {ln.item_id for ln in co.lines})
    lines = "\n".join(f"{names.get(ln.item_id, '?')} — {float(ln.quantity):g} шт" for ln in co.lines[:60])
    base = (s.get("base_url") or "").rstrip("/")
    fields: dict = {
        "TITLE": f"{co.invoice_no}" + (f" {co.customer}" if co.customer else "") + f", {p.qty:g} шт",
        "CATEGORY_ID": int(s["deal_category"]),
        "COMMENTS": (f"Заказ в программе: {base}/customer-orders/{co.id}\n" if base else "") + lines,
        "CURRENCY_ID": "RUB",
    }
    if co.amount_rub is not None:
        fields["OPPORTUNITY"] = float(co.amount_rub)
    mgr = _manager_bx(db, co)
    if mgr:
        fields["ASSIGNED_BY_ID"] = mgr
    if s.get("deal_ship_field") and (co.ship_date or co.ship_to):
        fields[s["deal_ship_field"]] = (co.ship_date or co.ship_to).isoformat()
    return int(bx.call(s["webhook"], "crm.deal.add", {"fields": fields})["result"])


def comment(db: Session, co: CustomerOrder, text: str) -> None:
    """Запись в ленту сделки — через журнал отправки, после commit."""
    s = bx.get_settings(db)
    if co.bitrix_deal_id and enabled(s):
        bx.enqueue(db, "deal_comment", "crm.timeline.comment.add",
                   {"fields": {"ENTITY_ID": co.bitrix_deal_id, "ENTITY_TYPE": "deal", "COMMENT": text}})


def push_ship_date(db: Session, co: CustomerOrder) -> None:
    s = bx.get_settings(db)
    if co.bitrix_deal_id and enabled(s) and s.get("deal_ship_field") and co.ship_date:
        bx.enqueue(db, "deal_ship_date", "crm.deal.update",
                   {"id": co.bitrix_deal_id, "fields": {s["deal_ship_field"]: co.ship_date.isoformat()}})


def push_stage(db: Session, s: dict, co: CustomerOrder, stage: str, order: list[str] | None = None) -> bool:
    """Передвинуть сделку на стадию заказа — только вперёд; закрытые не трогать."""
    target = s.get(STAGE_KEYS.get(stage, ""))
    if not co.bitrix_deal_id or not target:
        return False
    order = order or stages(s)
    deal = bx.call(s["webhook"], "crm.deal.get", {"id": co.bitrix_deal_id}).get("result") or {}
    cur = deal.get("STAGE_ID", "")
    if cur.endswith(CLOSED_SUFFIXES) or target not in order:
        return False
    if cur in order and order.index(cur) >= order.index(target):
        return False
    bx.call(s["webhook"], "crm.deal.update", {"id": co.bitrix_deal_id, "fields": {"STAGE_ID": target}})
    return True


def link_or_create(db: Session, co: CustomerOrder, allow_create: bool) -> str:
    """Привязать найденную по счёту сделку или создать; без commit.
    Возвращает: linked / created / many / none / off."""
    s = bx.get_settings(db)
    if not enabled(s) or co.bitrix_deal_id:
        return "off"
    found = find_deals(s, co.invoice_no)
    if len(found) == 1:
        co.bitrix_deal_id = int(found[0]["ID"])
        base = (s.get("base_url") or "").rstrip("/")
        comment(db, co, f"Связана с заказом клиента в программе учёта{': ' + base + '/customer-orders/' + str(co.id) if base else ''}")
        return "linked"
    if len(found) > 1:
        return "many"
    if allow_create and s.get("deal_auto_create"):
        co.bitrix_deal_id = create_deal(db, s, co)
        return "created"
    return "none"


def link_in_background(co_id: int) -> None:
    """После отправки заказа производству — не задерживая ответ."""

    def run() -> None:
        from app.db.session import SessionLocal

        db = SessionLocal()
        try:
            co = db.get(CustomerOrder, co_id)
            if co is not None:
                link_or_create(db, co, allow_create=True)
                db.commit()
        except Exception:  # noqa: BLE001 — фон не должен падать
            log.exception("bitrix deal link %s", co_id)
            db.rollback()
        finally:
            db.close()

    threading.Thread(target=run, daemon=True).start()


def sync(db: Session) -> dict:
    """Фоном раз в 20 минут: заказам без сделки — найти/создать; стадии —
    вперёд по ходу заказа."""
    from app.services.customer_orders import progress

    s = bx.get_settings(db)
    if not enabled(s):
        return {"off": True}
    out = {"linked": 0, "created": 0, "moved": 0, "errors": 0}
    order: list[str] | None = None
    for co in db.query(CustomerOrder).filter(CustomerOrder.status.in_(["submitted", "accepted"])):
        try:
            if not co.bitrix_deal_id:
                r = link_or_create(db, co, allow_create=True)
                if r in ("linked", "created"):
                    out[r] += 1
                    db.commit()
            if not co.bitrix_deal_id:
                continue
            stage = progress(db, co).stage
            if stage == co.bitrix_stage_sent:
                continue
            order = order or stages(s)
            if push_stage(db, s, co, stage, order):
                out["moved"] += 1
            co.bitrix_stage_sent = stage
            db.commit()
        except bx.BitrixError as e:
            log.warning("bitrix deal sync %s: %s", co.id, e)
            out["errors"] += 1
            db.rollback()
    return out


def fmt(v: date | None) -> str:
    return v.strftime("%d.%m.%Y") if v else "—"
