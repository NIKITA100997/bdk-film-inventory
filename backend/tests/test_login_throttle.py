from app.services import login_throttle
from app.services.login_throttle import register_failure, register_success, seconds_until_unlocked


def _fresh_key(name: str) -> str:
    """Каждый тест — свой ключ, чтобы не зависеть от порядка выполнения
    (общий module-level словарь _failures иначе делился бы между тестами)."""
    return f"test:{name}:{id(object())}"


class TestSecondsUntilUnlocked:
    def test_no_attempts_is_not_locked(self):
        assert seconds_until_unlocked(_fresh_key("none")) is None

    def test_below_threshold_is_not_locked(self):
        key = _fresh_key("below")
        now = 1_000_000.0
        for _ in range(login_throttle.MAX_FAILURES - 1):
            register_failure(key, now)
        assert seconds_until_unlocked(key, now) is None

    def test_at_threshold_is_locked(self):
        key = _fresh_key("at")
        now = 1_000_000.0
        for _ in range(login_throttle.MAX_FAILURES):
            register_failure(key, now)
        wait = seconds_until_unlocked(key, now)
        assert wait is not None
        assert wait == login_throttle.LOCKOUT_SECONDS

    def test_lockout_expires_after_lockout_seconds(self):
        key = _fresh_key("expires")
        now = 1_000_000.0
        for _ in range(login_throttle.MAX_FAILURES):
            register_failure(key, now)
        later = now + login_throttle.LOCKOUT_SECONDS + 1
        assert seconds_until_unlocked(key, later) is None

    def test_old_failures_outside_window_do_not_count(self):
        key = _fresh_key("window")
        now = 1_000_000.0
        # Все неудачи, кроме одной, случились до начала окна — не должны
        # засчитаться, порог не достигнут.
        for _ in range(login_throttle.MAX_FAILURES - 1):
            register_failure(key, now - login_throttle.WINDOW_SECONDS - 10)
        register_failure(key, now)
        assert seconds_until_unlocked(key, now) is None

    def test_register_success_clears_failures(self):
        key = _fresh_key("success")
        now = 1_000_000.0
        for _ in range(login_throttle.MAX_FAILURES):
            register_failure(key, now)
        register_success(key)
        assert seconds_until_unlocked(key, now) is None
