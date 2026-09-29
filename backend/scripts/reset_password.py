"""Сброс пароля с сервера — когда пароль забыл сам администратор и сбросить
через «Пользователи» некому.

    .venv\\Scripts\\python scripts\\reset_password.py <логин>           — проверить, есть ли такой
    .venv\\Scripts\\python scripts\\reset_password.py <логин> --apply   — сбросить, напечатать временный

При входе с временным паролем система сразу попросит задать свой.
"""

import secrets
import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.models  # noqa: E402,F401 — все модели для связей
from app.core.security import hash_password  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.models.users import User  # noqa: E402


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--apply"]
    if len(args) != 1:
        print(__doc__)
        sys.exit(1)
    apply = "--apply" in sys.argv
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == args[0]).first()
        if user is None:
            print(f"Пользователь «{args[0]}» не найден. Логины:", ", ".join(u.username for u in db.query(User).order_by(User.username)))
            sys.exit(1)
        print(f"{user.username} — {user.full_name}{' (суперпользователь)' if user.is_superuser else ''}{'' if user.is_active else ', ОТКЛЮЧЁН'}")
        if not apply:
            print("Проверка. Для сброса добавьте --apply")
            return
        temp = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(10))
        user.password_hash = hash_password(temp)
        user.must_change_password = True
        user.password_reset_requested_at = None
        user.is_active = True
        db.commit()
        print(f"Временный пароль: {temp}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
