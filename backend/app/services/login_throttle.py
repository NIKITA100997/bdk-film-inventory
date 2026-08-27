"""Ограничение попыток входа (раздел про открытие сервера в интернет под
доменом) — до сих пор сервер был доступен только участникам Tailscale-сети,
подбор пароля посторонним не грозил; при открытом доступе из интернета это
меняется, а собственной защиты от перебора паролей в /auth/login не было
вообще.

In-process счётчик неудачных попыток — по логину (не дают перебирать
пароль к конкретному аккаунту) и по IP (не дают перебирать много логинов
подряд с одного адреса), независимо друг от друга. Без внешних зависимостей
(Redis и т.п.) — сервис работает одним процессом uvicorn (см. start_fast.bat),
общей памяти процесса достаточно; счётчик сбрасывается при перезапуске
сервера — это осознанно приемлемо, не защита военного уровня, а именно
преграда автоматическому перебору."""

import threading
import time

MAX_FAILURES = 5
WINDOW_SECONDS = 15 * 60
LOCKOUT_SECONDS = 15 * 60

_lock = threading.Lock()
_failures: dict[str, list[float]] = {}


def _prune(key: str, now: float) -> list[float]:
    attempts = [t for t in _failures.get(key, []) if now - t < WINDOW_SECONDS]
    if attempts:
        _failures[key] = attempts
    else:
        _failures.pop(key, None)
    return attempts


def seconds_until_unlocked(key: str, now: float | None = None) -> float | None:
    """None — не заблокирован; иначе сколько секунд ждать до следующей
    попытки. `now` — необязательный параметр только для тестов (иначе
    time.time())."""
    now = time.time() if now is None else now
    with _lock:
        attempts = _prune(key, now)
    if len(attempts) < MAX_FAILURES:
        return None
    remaining = attempts[-1] + LOCKOUT_SECONDS - now
    return remaining if remaining > 0 else None


def register_failure(key: str, now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _lock:
        _failures.setdefault(key, []).append(now)


def register_success(key: str) -> None:
    with _lock:
        _failures.pop(key, None)
