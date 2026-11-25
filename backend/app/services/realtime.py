"""Лёгкий in-process pub/sub брокер для Server-Sent Events (SSE).
Позволяет синхронным роутерам и фоновым задачам мгновенно уведомлять
цеховые и складские экраны без стороннего брокера."""

from __future__ import annotations

import asyncio
import threading
from typing import Any


class EventBroker:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]] = set()

    def subscribe(self) -> tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]:
        loop = asyncio.get_running_loop()
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        entry = (loop, q)
        with self._lock:
            self._subscribers.add(entry)
        return entry

    def unsubscribe(self, entry: tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]) -> None:
        with self._lock:
            self._subscribers.discard(entry)

    def publish(self, topic: str, data: dict[str, Any] | None = None) -> None:
        payload = {"topic": topic, "data": data or {}}
        with self._lock:
            subs = list(self._subscribers)
        for loop, q in subs:
            if loop.is_closed():
                self.unsubscribe((loop, q))
                continue
            try:
                loop.call_soon_threadsafe(_safe_put, q, payload)
            except RuntimeError:
                self.unsubscribe((loop, q))


def _safe_put(q: asyncio.Queue[dict[str, Any]], payload: dict[str, Any]) -> None:
    if q.full():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        pass


broker = EventBroker()


def publish_event(topic: str, data: dict[str, Any] | None = None) -> None:
    """Публикует событие для подключённых SSE-клиентов (безопасно из sync и async)."""
    broker.publish(topic, data)
