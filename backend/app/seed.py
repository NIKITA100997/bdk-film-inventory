"""Разовый сидинг: технический администратор для первого входа.
Запуск: .venv\\Scripts\\python.exe -m app.seed
"""

from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models.users import User


def main() -> None:
    db = SessionLocal()
    try:
        if db.query(User).filter(User.username == "admin").first():
            print("Пользователь admin уже существует")
            return
        admin = User(
            username="admin",
            password_hash=hash_password("admin"),
            full_name="Администратор",
            is_superuser=True,
            is_active=True,
        )
        db.add(admin)
        db.commit()
        print("Создан пользователь admin / admin — сменить пароль после первого входа")
    finally:
        db.close()


if __name__ == "__main__":
    main()
