import secrets
import string

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import hash_password, require_permission
from app.db.session import get_db
from app.models.roles import Role
from app.models.users import User
from app.schemas.users import ResetPasswordResult, UserCreate, UserCreateResult, UserOut, UserUpdate
from app.services.users import area_is_missing, resolve_area

router = APIRouter(prefix="/users", tags=["users"])

# Администрирование пользователей (5.6 ТЗ) — доступ только логисту/
# руководителю (суперпользователь проходит всегда через require_permission).
manage_users = require_permission("users.manage")


def _generate_temp_password() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(10))


def _users_query(db: Session):
    return db.query(User).options(joinedload(User.roles))


def _resolve_roles(db: Session, role_ids: list[int]) -> list[Role]:
    if not role_ids:
        return []
    roles = db.query(Role).filter(Role.id.in_(role_ids)).all()
    if len(roles) != len(set(role_ids)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Одна или несколько ролей не найдены")
    return roles


@router.get("", response_model=list[UserOut])
def list_all_users(db: Session = Depends(get_db), user: User = Depends(manage_users)) -> list[User]:
    """Полный список для администрирования, включая отключённых — в отличие
    от GET /auth/users (только активные, для выбора участников сессии)."""
    return _users_query(db).order_by(User.full_name).all()


@router.post("", response_model=UserCreateResult, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate, db: Session = Depends(get_db), user: User = Depends(manage_users)
) -> UserCreateResult:
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Логин уже занят")
    if not payload.is_superuser and not payload.role_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нужно выбрать хотя бы одну роль или отметить суперпользователя")

    roles = _resolve_roles(db, payload.role_ids)
    role_codes = {r.code for r in roles if r.code}
    resolved_area = resolve_area(role_codes, payload.area)
    if area_is_missing(role_codes, resolved_area):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Для роли «начальник участка» нужно указать участок")

    temp_password = payload.password or _generate_temp_password()
    new_user = User(
        username=payload.username,
        password_hash=hash_password(temp_password),
        full_name=payload.full_name,
        roles=roles,
        is_superuser=payload.is_superuser,
        area=resolved_area,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return UserCreateResult(user=new_user, temporary_password=temp_password)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int, payload: UserUpdate, db: Session = Depends(get_db), user: User = Depends(manage_users)
) -> User:
    target = _users_query(db).filter(User.id == user_id).first()
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")

    if payload.full_name is not None:
        target.full_name = payload.full_name

    effective_is_superuser = payload.is_superuser if payload.is_superuser is not None else target.is_superuser
    effective_roles = _resolve_roles(db, payload.role_ids) if payload.role_ids is not None else target.roles
    if not effective_is_superuser and not effective_roles:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нужно выбрать хотя бы одну роль или отметить суперпользователя")

    role_codes = {r.code for r in effective_roles if r.code}
    resolved_area = resolve_area(role_codes, payload.area, target.area)
    if area_is_missing(role_codes, resolved_area):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Для роли «начальник участка» нужно указать участок")
    target.area = resolved_area

    if payload.role_ids is not None:
        target.roles = effective_roles
    if payload.is_superuser is not None:
        target.is_superuser = payload.is_superuser
    if payload.is_active is not None:
        target.is_active = payload.is_active

    db.commit()
    db.refresh(target)
    return target


@router.post("/{user_id}/reset-password", response_model=ResetPasswordResult)
def reset_password(
    user_id: int, db: Session = Depends(get_db), user: User = Depends(manage_users)
) -> ResetPasswordResult:
    """Сброс пароля (3 раздел бэклога) — деактивация вместо удаления уже
    покрыта is_active в update_user, история событий по автору не теряется."""
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    temp_password = _generate_temp_password()
    target.password_hash = hash_password(temp_password)
    db.commit()
    return ResetPasswordResult(temporary_password=temp_password)
