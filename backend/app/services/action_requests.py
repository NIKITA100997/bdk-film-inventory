"""Запросы администратору (07.10.2026): что за действие — по-русски, по пути
и телу запроса; выполнение подтверждённого запроса от имени администратора.
"""

import json
import re

from sqlalchemy.orm import Session

ALLOWED_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# пароли, вход и сами запросы через «попросить» не проводим
DENIED_PREFIXES = ("/api/auth", "/api/action-requests", "/api/period-closing", "/api/users")
MAX_BODY = 100_000

VERB = {"POST": "Действие", "PUT": "Изменение", "PATCH": "Изменение", "DELETE": "Удаление"}


def _roll(m):
    return f"ПЛ-{m.group(1)}"


def _pf(m):
    return f"ПФ-{m.group(1)}"


# (метод, шаблон пути без /api, текст) — {1}, {2}… — группы пути
PATTERNS: list[tuple[str, str, str]] = [
    ("POST", r"/units/(\d+)/return", "Возврат рулона ПЛ-{1} на склад"),
    ("POST", r"/units/(\d+)/consume", "Рулон ПЛ-{1} израсходован участком"),
    ("POST", r"/units/(\d+)/cut", "Раскрой рулона ПЛ-{1} по длине"),
    ("POST", r"/units/(\d+)/write-?off", "Списание рулона ПЛ-{1}"),
    ("POST", r"/units/(\d+)/correct\w*", "Корректировка рулона ПЛ-{1}"),
    ("POST", r"/units/(\d+)/place", "Размещение рулона ПЛ-{1}"),
    ("POST", r"/units/(\d+)/issue\w*", "Выдача рулона ПЛ-{1} участку"),
    ("POST", r"/units/(\d+)/(\w[\w-]*)", "Рулон ПЛ-{1}: {2}"),
    ("DELETE", r"/units/(\d+)", "Удаление рулона ПЛ-{1}"),
    ("POST", r"/part-units/(\d+)/(\w[\w-]*)", "Партия ПФ-{1}: {2}"),
    ("DELETE", r"/part-units/(\d+)", "Удаление партии ПФ-{1}"),
    ("POST", r"/production-tasks/(\d+)/lines/(\d+)/reports(/batch)?", "Отчёт о производстве: задание №{1}, строка {2}"),
    ("POST", r"/production-tasks/(\d+)/complete", "Закрыть задание №{1}: всё сделано"),
    ("DELETE", r"/production-tasks/(\d+)/lines/(\d+)/reports/(\d+)", "Удалить отчёт №{3} (задание №{1})"),
    ("DELETE", r"/production-tasks/(\d+)", "Удалить задание №{1}"),
    ("PATCH", r"/production-tasks/(\d+)", "Изменить задание №{1}"),
    ("POST", r"/production-orders/(\d+)/release", "Запустить заказ №{1} в работу"),
    ("POST", r"/production-orders/(\d+)/complete", "Закрыть заказ №{1}: всё сделано"),
    ("POST", r"/production-orders/(\d+)/close", "Закрыть заказ №{1}"),
    ("DELETE", r"/production-orders/(\d+)", "Удалить заказ №{1}"),
    ("POST", r"/finished-goods/shipments/(\d+)/cancel", "Отменить отгрузку №{1}"),
    ("POST", r"/finished-goods/shipments/(\d+)/return", "Возврат от клиента по отгрузке №{1}"),
    ("POST", r"/finished-goods/shipments", "Отгрузка по счёту"),
    ("POST", r"/finished-goods/transfer", "Перевозка готовых дверей между площадками"),
    ("POST", r"/finished-goods/adjust", "Корректировка склада готовой продукции"),
    ("POST", r"/items/(\d+)/prices", "Новая цена позиции"),
    ("DELETE", r"/item-prices/(\d+)", "Удалить цену №{1}"),
    ("POST", r"/part-counts/(\d+)/(\w[\w-]*)", "Пересчёт п/ф №{1}: {2}"),
    ("POST", r"/inventory/(\d+)/(\w[\w-]*)", "Инвентаризация №{1}: {2}"),
    ("PATCH", r"/areas/([\w-]+)", "Изменить участок {1}"),
]


def _body_hint(path: str, body) -> str:
    """Пара слов о содержимом: штуки в отчёте, счёт отгрузки и т. п."""
    if not isinstance(body, (dict, list)):
        return ""
    items = body if isinstance(body, list) else [body]
    if "/reports" in path:
        good = sum(float(x.get("good_pieces") or 0) for x in items if isinstance(x, dict))
        bad = sum(float(x.get("defect_pieces") or 0) for x in items if isinstance(x, dict))
        return f": годных {good:g}, брак {bad:g}"
    if isinstance(body, dict):
        for key, label in (("invoice_no", "счёт"), ("reason", "причина"), ("qty", "шт"), ("actual_qty", "факт"),
                           ("cut_length_m", "м"), ("price", "цена")):
            if body.get(key) not in (None, ""):
                return f" ({label} {body[key]})"
    return ""


def describe(db: Session, method: str, path: str, body) -> str:
    rel = path[4:] if path.startswith("/api/") else path
    rel = rel.split("?")[0]
    for m, pat, text in PATTERNS:
        if m != method:
            continue
        g = re.fullmatch(pat, rel)
        if g:
            out = text
            for i, val in enumerate(g.groups(), 1):
                out = out.replace("{" + str(i) + "}", val or "")
            if "/items/" in rel and "/prices" in rel:
                from app.models.items import Item

                it = db.get(Item, int(g.group(1)))
                if it is not None:
                    out += f" «{it.name}»"
            return (out + _body_hint(rel, body))[:500]
    return f"{VERB.get(method, method)}: {rel}{_body_hint(rel, body)}"[:500]


def parse_body(raw: str | None):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None
