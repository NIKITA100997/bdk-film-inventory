"""Цены — по отдельному праву (14.10, решение пользователя): остатки и
движения видят все, кому положен склад, а закупочные цены, стоимость
остатков и себестоимость — только с правом «Просмотр цен» или «Управление
ценами» (и суперпользователь).

Право определяется один раз на запрос, в прослойке (по токену из
заголовка), и хранится в contextvar; денежные поля моделей ответа
(рулон, партия п/ф, материал, движение материала, сводка склада) при
выдаче становятся пустыми, если права нет. Так закрываются сразу все
запросы, которые отдают эти модели, без правки каждого.

Без токена (внутренние вызовы, тесты) — цены видны: запросы без входа
и так отклоняются проверкой авторизации."""

import time
from contextvars import ContextVar

from jose import JWTError, jwt
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

PRICE_PERMS = {"prices.view", "prices.manage"}
_sees: ContextVar[bool] = ContextVar("sees_prices", default=True)
_cache: dict[str, tuple[float, bool]] = {}
TTL = 30.0


def sees_prices() -> bool:
    return _sees.get()


def hide(value):
    """Для field_serializer: значение или пусто, если цен не видно."""
    return value if _sees.get() else None


def _lookup(username: str) -> bool:
    from app.core.security import get_permission_codes
    from app.db.session import SessionLocal
    from app.models.users import User

    now = time.monotonic()
    hit = _cache.get(username)
    if hit and now - hit[0] < TTL:
        return hit[1]
    db = SessionLocal()
    try:
        u = db.query(User).filter(User.username == username).first()
        ok = bool(u and (u.is_superuser or not get_permission_codes(u).isdisjoint(PRICE_PERMS)))
    finally:
        db.close()
    _cache[username] = (now, ok)
    return ok


async def price_visibility_middleware(request, call_next):
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return await call_next(request)
    try:
        username = jwt.decode(auth[7:], settings.jwt_secret, algorithms=[settings.jwt_algorithm]).get("sub")
    except JWTError:
        username = None
    sees = bool(username) and await run_in_threadpool(_lookup, username)
    token = _sees.set(sees)
    try:
        return await call_next(request)
    finally:
        _sees.reset(token)
