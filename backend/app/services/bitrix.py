"""Битрикс24 (облако) через входящий вебхук (12.10).

Программа — место, где живут заказ, план и факт; в Битрикс24 уходят
события: в чаты служб и лично менеджеру, задачи. Каждое сообщение пишется
в bitrix_outbox и отправляется в фоне — сбой Битрикса не мешает работе;
неотправленное видно в настройках и отправляется повторно.

Настройки (app_settings, ключ "bitrix"): webhook — адрес вебхука
(https://<портал>.bitrix24.ru/rest/<id>/<код>/), base_url — адрес программы
для ссылок, chat_production — чат «ПРОИЗВОДСТВО | Межкомнатные»
(DIALOG_ID вида chat123), chat_logistics — «ЛОГИСТИКА | Транспорт»,
chat_purchasing — «ЗАКУПКИ | Склад», purchaser — пользователь Битрикса,
кому ставить задачи на закупку, enabled — включено."""

import logging
import threading
from datetime import date, datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.integrations import AppSetting, BitrixOutbox
from app.models.users import User

log = logging.getLogger(__name__)
KEY = "bitrix"
TIMEOUT = 10.0


def get_settings(db: Session) -> dict:
    row = db.get(AppSetting, KEY)
    return dict(row.value or {}) if row and isinstance(row.value, dict) else {}


def save_settings(db: Session, value: dict, user_id: int) -> None:
    row = db.get(AppSetting, KEY)
    if row is None:
        row = AppSetting(key=KEY)
        db.add(row)
    row.value = value
    row.updated_by = user_id


class BitrixError(Exception):
    pass


def call(webhook: str, method: str, params: dict | None = None) -> dict:
    """Вызов метода REST; ошибка Битрикса — BitrixError с его текстом."""
    if not webhook:
        raise BitrixError("Не задан адрес вебхука")
    url = webhook.rstrip("/") + f"/{method}.json"
    try:
        r = httpx.post(url, json=params or {}, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        raise BitrixError(f"Битрикс24 не отвечает: {e}") from e
    try:
        data = r.json()
    except ValueError as e:
        raise BitrixError(f"Битрикс24 ответил {r.status_code}") from e
    if "error" in data:
        raise BitrixError(f"{data.get('error')}: {data.get('error_description', '')}".strip())
    return data


def _send(outbox_id: int) -> None:
    db = SessionLocal()
    try:
        row = db.get(BitrixOutbox, outbox_id)
        if row is None:
            return
        s = get_settings(db)
        try:
            call(s.get("webhook", ""), row.method, row.params)
            row.status, row.error, row.sent_at = "sent", None, datetime.now(timezone.utc)
        except BitrixError as e:
            row.status, row.error = "error", str(e)[:500]
        db.commit()
    except Exception:  # noqa: BLE001 — фон не должен ронять процесс
        log.exception("bitrix send %s", outbox_id)
        db.rollback()
    finally:
        db.close()


def enqueue(db: Session, event: str, method: str, params: dict) -> None:
    """Записать в журнал и отправить после commit вызывающего (в фоне)."""
    s = get_settings(db)
    if not s.get("enabled") or not s.get("webhook"):
        return
    row = BitrixOutbox(event=event, method=method, params=params)
    db.add(row)
    db.flush()
    rid = row.id

    from sqlalchemy import event as sa_event

    def after_commit(_session):
        threading.Thread(target=_send, args=(rid,), daemon=True).start()

    sa_event.listen(db, "after_commit", after_commit, once=True)


def retry(db: Session, outbox_id: int) -> None:
    row = db.get(BitrixOutbox, outbox_id)
    if row is not None:
        row.status = "new"
        db.commit()
        threading.Thread(target=_send, args=(outbox_id,), daemon=True).start()


# ─── сообщения ────────────────────────────────────────────────────────────


def _link(s: dict, path: str, text: str) -> str:
    base = (s.get("base_url") or "").rstrip("/")
    return f"[URL={base}{path}]{text}[/URL]" if base else text


def _d(v: date | None) -> str:
    return v.strftime("%d.%m.%Y") if v else "—"


def message_to_chat(db: Session, event: str, chat_key: str, text: str) -> None:
    s = get_settings(db)
    dialog = s.get(chat_key)
    if dialog:
        enqueue(db, event, "im.message.add", {"DIALOG_ID": dialog, "MESSAGE": text})


def message_to_user(db: Session, event: str, user_id: int | None, text: str) -> None:
    u = db.get(User, user_id) if user_id else None
    if u is not None and u.bitrix_user_id:
        enqueue(db, event, "im.message.add", {"DIALOG_ID": str(u.bitrix_user_id), "MESSAGE": text})


def order_title(db: Session, order) -> str:
    from app.models.customer_orders import CustomerOrder

    s = get_settings(db)
    if isinstance(order, CustomerOrder):  # с 13.10 заявки и даты — по заказам клиентов
        return _link(s, f"/customer-orders/{order.id}", f"Заказ клиента, {order.name}")
    title = f"Заказ №{order.id} «{order.name}»" + (f" · {order.customer}" if getattr(order, "customer", None) else "")
    return _link(s, f"/production-orders/{order.id}", title)


PRIORITY = ["", " [B]высокий приоритет[/B]", " [B]СРОЧНО[/B]"]


def on_request_submitted(db: Session, order, user: User) -> None:
    qty = sum(float(ln.quantity) for ln in order.lines)
    text = (
        f"Новая заявка на производство{PRIORITY[order.priority or 0]}: {order_title(db, order)}\n"
        f"{qty:g} шт, вилка отгрузки {_d(order.ship_from)} — {_d(order.ship_to)}; менеджер {user.full_name or user.username}"
        + (f"\nКомментарий: {order.request_comment}" if order.request_comment else "")
    )
    message_to_chat(db, "request_submitted", "chat_production", text)


def on_request_decided(db: Session, order, accepted: bool) -> None:
    whom = order.submitted_by or order.created_by
    if accepted:
        text = (
            f"Заявка принята: {order_title(db, order)}\n"
            f"Готовность {_d(order.promised_ready)}, отгрузка {_d(order.ship_date)}"
            + (f"\nКомментарий: {order.request_comment}" if order.request_comment else "")
        )
    else:
        text = f"Заявка возвращена: {order_title(db, order)}\nПричина: {order.request_comment}"
    message_to_user(db, "request_accepted" if accepted else "request_returned", getattr(order, "manager_id", None) or whom, text)


def on_promise_changed(db: Session, order, changes: list[tuple[str, date | None, date | None]], reason: str | None, comment: str | None) -> None:
    if not changes:
        return
    names = {"ship": "отгрузка", "ready": "готовность", "ready_fact": "факт готовности"}
    lines = "\n".join(f"{names.get(f, f)}: {_d(a)} → {_d(b)}" for f, a, b in changes)
    why = ", ".join(x for x in (reason, comment) if x)
    text = f"Перенос дат: {order_title(db, order)}\n{lines}" + (f"\nПричина: {why}" if why else "")
    message_to_user(db, "promise_changed", getattr(order, "manager_id", None) or order.submitted_by or order.created_by, text)


def task_for_purchase(db: Session, title: str, description: str, deadline: date | None) -> None:
    s = get_settings(db)
    if s.get("purchaser"):
        fields = {"TITLE": title, "DESCRIPTION": description, "RESPONSIBLE_ID": int(s["purchaser"])}
        if deadline:
            fields["DEADLINE"] = deadline.strftime("%Y-%m-%dT18:00:00")
        enqueue(db, "purchase_task", "tasks.task.add", {"fields": fields})
    message_to_chat(db, "purchase_task", "chat_purchasing", f"{title}\n{description}")
