"""Фоновый воркер для тяжёлых задач (генерация пакетных PDF-этикеток,
тяжёлые выгрузки и пересчёты) — разгружает основной HTTP-поток uvicorn."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import threading
from typing import Any, Callable
import uuid


@dataclass
class BackgroundJob:
    job_id: str
    name: str
    status: str = "pending"  # pending | running | done | error
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: datetime | None = None
    result_bytes: bytes | None = None
    content_type: str | None = None
    filename: str | None = None
    result_meta: dict[str, Any] | None = None
    error: str | None = None


_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bdk-bg-worker")
_jobs_lock = threading.Lock()
_jobs: dict[str, BackgroundJob] = {}


def _prune_old_jobs() -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    stale = [jid for jid, j in _jobs.items() if j.created_at < cutoff and j.status in ("done", "error")]
    for jid in stale:
        _jobs.pop(jid, None)


def submit_job(
    name: str,
    fn: Callable[..., Any],
    *args: Any,
    content_type: str | None = None,
    filename: str | None = None,
    **kwargs: Any,
) -> str:
    """Ставит тяжёлую функцию в фоновый пул и возвращает job_id."""
    job_id = uuid.uuid4().hex[:16]
    job = BackgroundJob(job_id=job_id, name=name, content_type=content_type, filename=filename)
    with _jobs_lock:
        _prune_old_jobs()
        _jobs[job_id] = job

    def _runner() -> None:
        with _jobs_lock:
            job.status = "running"
        try:
            res = fn(*args, **kwargs)
            with _jobs_lock:
                if isinstance(res, bytes):
                    job.result_bytes = res
                    job.result_meta = {"size_bytes": len(res)}
                elif isinstance(res, dict):
                    job.result_meta = res
                job.status = "done"
                job.finished_at = datetime.now(timezone.utc)
        except Exception as exc:  # noqa: BLE001
            with _jobs_lock:
                job.status = "error"
                job.error = str(exc)[:500]
                job.finished_at = datetime.now(timezone.utc)

    _executor.submit(_runner)
    return job_id


def get_job(job_id: str) -> BackgroundJob | None:
    with _jobs_lock:
        return _jobs.get(job_id)
