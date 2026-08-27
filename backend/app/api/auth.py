from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session, joinedload

from app.core.security import create_access_token, get_current_user, get_permission_codes, verify_password
from app.db.session import get_db
from app.models.roles import Permission
from app.models.users import User
from app.schemas.users import CurrentUserOut, Token, UserOut
from app.services.login_throttle import register_failure, register_success, seconds_until_unlocked

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)) -> Token:
    # Раздел про открытие сервера в интернет под доменом — до этого
    # подбор пароля посторонним не грозил (доступ только из Tailscale-сети);
    # ключи и по логину, и по IP независимо, см. services/login_throttle.py.
    ip = request.client.host if request.client else "unknown"
    throttle_keys = [f"user:{form_data.username}", f"ip:{ip}"]
    for key in throttle_keys:
        wait = seconds_until_unlocked(key)
        if wait is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Слишком много неудачных попыток входа — попробуйте через {int(wait // 60) + 1} мин.",
            )

    user = db.query(User).filter(User.username == form_data.username).first()
    if user is None or not verify_password(form_data.password, user.password_hash):
        for key in throttle_keys:
            register_failure(key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный логин или пароль")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Пользователь отключён")
    for key in throttle_keys:
        register_success(key)
    return Token(access_token=create_access_token(subject=user.username))


@router.get("/me", response_model=CurrentUserOut)
def me(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> CurrentUserOut:
    """Эффективные права (8.3 раздел бэклога доработок) — суперпользователь
    получает полный каталог прав (нужен фронту для гейтинга навигации так же,
    как и обычным ролям, хотя backend-проверки суперпользователь проходит и
    без этого списка)."""
    if user.is_superuser:
        permissions = [p.code for p in db.query(Permission).all()]
    else:
        permissions = sorted(get_permission_codes(user))
    return CurrentUserOut(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        roles=user.roles,
        is_superuser=user.is_superuser,
        permissions=permissions,
        area=user.area,
        is_active=user.is_active,
    )


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[User]:
    """Список активных пользователей — нужен для выбора участников сессии
    инвентаризации (5.4 ТЗ: "создание сессии (область, участники)")."""
    return (
        db.query(User)
        .options(joinedload(User.roles))
        .filter(User.is_active)
        .order_by(User.full_name)
        .all()
    )
