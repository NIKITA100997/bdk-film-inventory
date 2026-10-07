from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.users import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def create_access_token(*, subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_action_token(*, subject: str, request_id: int) -> str:
    """Короткий токен для выполнения подтверждённого запроса сотрудника
    (07.10): от имени администратора, с номером запроса — даёт право
    писать в закрытый период (см. services/period_guard.py)."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=2)
    payload = {"sub": subject, "exp": expire, "act": request_id}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Не удалось подтвердить учётные данные",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        username = payload.get("sub")
        if username is None:
            raise credentials_error
    except JWTError:
        raise credentials_error

    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_error
    act = payload.get("act")
    if act is not None:
        from app.models.control import REQ_EXECUTING, ActionRequest

        req = db.get(ActionRequest, int(act))
        if req is None or req.status != REQ_EXECUTING or req.resolved_by != user.id:
            raise credentials_error
        db.info["period_override"] = True
        db.info["action_request_id"] = req.id
    return user


def get_permission_codes(user: User) -> set[str]:
    """Объединение прав по всем ролям пользователя (8.3 раздел бэклога
    доработок) — суперпользователь сюда не заходит, у него отдельный флаг."""
    return {perm.code for role in user.roles if role.is_active for perm in role.permissions}


def require_permission(*permission_codes: str):
    """Замена require_roles(*roles) — семантика "любое из перечисленных"
    сохранена 1:1, только источник теперь назначаемые права, а не хардкод
    имён ролей."""

    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.is_superuser:
            return user
        if get_permission_codes(user).isdisjoint(permission_codes):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Недостаточно прав")
        return user

    return dependency
