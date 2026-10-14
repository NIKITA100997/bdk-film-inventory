"""Фоновый поток процесса сервера. Раз в 5 минут — повтор неотправленных
сообщений Битрикс24 (14.10); раз в 20 минут — утренняя сводка отставаний
(12.10: рабочий день, после 9:00, сегодня ещё не отправляли —
services/order_control.lag_digest помнит день сам) и сверка сделок."""

import logging
import threading
import time
from datetime import datetime

log = logging.getLogger(__name__)
_started = [False]


def _loop() -> None:
    from app.db.session import SessionLocal
    from app.services.bitrix import retry_pending
    from app.services.bitrix_deals import sync as deals_sync
    from app.services.order_control import lag_digest

    tick = 0
    while True:
        try:
            db = SessionLocal()
            try:
                retry_pending(db)
            finally:
                db.close()
        except Exception:  # noqa: BLE001 — фон не должен падать
            log.exception("bitrix retry")
        tick += 1
        if tick % 4 != 1:  # остальное — раз в 20 минут (на 1-м, 5-м, 9-м… круге)
            time.sleep(5 * 60)
            continue
        try:
            if datetime.now().hour >= 9:
                db = SessionLocal()
                try:
                    lag_digest(db)
                finally:
                    db.close()
        except Exception:  # noqa: BLE001 — фон не должен падать
            log.exception("lag digest")
        # сделки Битрикс24 (14.10): привязать/создать, стадии вперёд по ходу заказа
        try:
            db = SessionLocal()
            try:
                deals_sync(db)
            finally:
                db.close()
        except Exception:  # noqa: BLE001
            log.exception("bitrix deals sync")
        time.sleep(5 * 60)


def start() -> None:
    if _started[0]:
        return
    _started[0] = True
    threading.Thread(target=_loop, name="lag-digest", daemon=True).start()
