"""Защита от повторной отправки (14.10, проверка качества).

Форма шлёт заголовок «Idempotency-Key» — один на операцию, пока она не
записана: повтор после обрыва сети (запрос дошёл и записался, ответ
потерялся, человек нажал ещё раз) приходит с тем же ключом, и сервер не
выполняет его второй раз, а отдаёт прежний ответ. Пока первый запрос ещё
выполняется, повтор ждёт его ответа.

Хранится в памяти процесса (сервис работает одним процессом uvicorn) на
15 минут; ключ — вместе с пользователем, чтобы ключи разных людей не
пересекались. Запоминаются только успешные ответы: отказ (неверные данные,
нет прав, ошибка сервера) можно исправить и отправить с тем же ключом.
Запросы без заголовка работают как раньше."""

import asyncio
import time

from jose import JWTError, jwt
from starlette.responses import Response

from app.core.config import settings

TTL = 15 * 60
WAIT = 60.0
_done: dict[str, tuple[float, int, bytes, str]] = {}  # ключ → (время, статус, тело, тип)
_running: dict[str, asyncio.Event] = {}


def _who(request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        try:
            return str(jwt.decode(auth[7:], settings.jwt_secret, algorithms=[settings.jwt_algorithm]).get("sub") or "")
        except JWTError:
            return ""
    return ""


def _prune(now: float) -> None:
    for k in [k for k, v in _done.items() if now - v[0] > TTL]:
        _done.pop(k, None)


def _replay(hit: tuple[float, int, bytes, str]) -> Response:
    _, code, body, ctype = hit
    return Response(content=body, status_code=code, media_type=ctype, headers={"Idempotent-Replay": "true"})


async def idempotency_middleware(request, call_next):
    raw = request.headers.get("idempotency-key")
    if not raw or request.method not in ("POST", "PUT", "PATCH", "DELETE"):
        return await call_next(request)
    key = f"{_who(request)}|{request.method}|{request.url.path}|{raw[:100]}"
    now = time.monotonic()
    _prune(now)
    if key in _done:
        return _replay(_done[key])
    ev = _running.get(key)
    if ev is not None:  # первый такой же запрос ещё выполняется — дождаться его ответа
        try:
            await asyncio.wait_for(ev.wait(), WAIT)
        except asyncio.TimeoutError:
            pass
        if key in _done:
            return _replay(_done[key])
        return Response(content='{"detail":"Операция ещё выполняется — подождите и обновите страницу"}', status_code=409,
                        media_type="application/json")
    ev = asyncio.Event()
    _running[key] = ev
    try:
        response = await call_next(request)
        if not 200 <= response.status_code < 300:
            return response
        body = b""
        async for chunk in response.body_iterator:
            body += chunk
        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        _done[key] = (time.monotonic(), response.status_code, body, response.media_type or headers.get("content-type", "application/json"))
        return Response(content=body, status_code=response.status_code, headers=headers, media_type=response.media_type)
    finally:
        _running.pop(key, None)
        ev.set()
