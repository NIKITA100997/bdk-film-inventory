"""Централизованное логирование, сквозной request_id и трекинг медленных запросов."""

from contextvars import ContextVar
import logging
import time
import uuid

from fastapi import Request

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
logger = logging.getLogger("bdk.http")


def setup_logging() -> None:
    """Единая конфигурация логирования для приложения."""
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )
    else:
        root.setLevel(logging.INFO)


async def request_logging_middleware(request: Request, call_next):
    """Присваивает X-Request-ID, замеряет длительность и логирует медленные/ошибочные запросы."""
    req_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    token = request_id_var.set(req_id)
    request.state.request_id = req_id
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
        logger.exception("req=%s %s %s failed in %.1fms", req_id, request.method, request.url.path, elapsed_ms)
        request_id_var.reset(token)
        raise
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    response.headers["X-Request-ID"] = req_id
    if response.status_code >= 500:
        logger.error("req=%s %s %s -> %s (%.1fms)", req_id, request.method, request.url.path, response.status_code, elapsed_ms)
    elif elapsed_ms > 1000:
        logger.warning("SLOW req=%s %s %s -> %s (%.1fms)", req_id, request.method, request.url.path, response.status_code, elapsed_ms)
    request_id_var.reset(token)
    return response
