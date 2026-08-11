"""Администрирование ролей и прав (8.3 раздел бэклога доработок) — роли
создаются и переименовываются в UI, права у роли — редактируемый набор
чекбоксов из фиксированного каталога `Permission`. Тот же логист, что сейчас
управляет пользователями (`users.manage`), управляет и этим — отдельного
права не заводим, иначе получаем курицу и яйцо (кто выдаёт право управлять
правами)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import require_permission
from app.db.session import get_db
from app.models.roles import Permission, Role
from app.schemas.roles import PermissionOut, RoleCreate, RoleOut, RolePermissionsUpdate, RoleUpdate

router = APIRouter(tags=["roles"])

manage_roles = require_permission("users.manage")


def _roles_query(db: Session):
    return db.query(Role).options(joinedload(Role.permissions))


@router.get("/roles", response_model=list[RoleOut])
def list_roles(db: Session = Depends(get_db), user=Depends(manage_roles)) -> list[Role]:
    return _roles_query(db).order_by(Role.name).all()


@router.post("/roles", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
def create_role(payload: RoleCreate, db: Session = Depends(get_db), user=Depends(manage_roles)) -> Role:
    if db.query(Role).filter(Role.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Роль с таким названием уже есть")
    role = Role(name=payload.name, code=None, is_active=True)
    db.add(role)
    db.commit()
    db.refresh(role)
    return role


@router.patch("/roles/{role_id}", response_model=RoleOut)
def update_role(role_id: int, payload: RoleUpdate, db: Session = Depends(get_db), user=Depends(manage_roles)) -> Role:
    role = db.get(Role, role_id)
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Роль не найдена")
    if payload.name is not None:
        if db.query(Role).filter(Role.name == payload.name, Role.id != role_id).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Роль с таким названием уже есть")
        role.name = payload.name
    if payload.is_active is not None:
        role.is_active = payload.is_active
    db.commit()
    db.refresh(role)
    return role


@router.put("/roles/{role_id}/permissions", response_model=RoleOut)
def update_role_permissions(
    role_id: int, payload: RolePermissionsUpdate, db: Session = Depends(get_db), user=Depends(manage_roles)
) -> Role:
    role = _roles_query(db).filter(Role.id == role_id).first()
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Роль не найдена")
    permissions = db.query(Permission).filter(Permission.id.in_(payload.permission_ids)).all()
    role.permissions = permissions
    db.commit()
    db.refresh(role)
    return role


@router.get("/permissions", response_model=list[PermissionOut])
def list_permissions(db: Session = Depends(get_db), user=Depends(manage_roles)) -> list[Permission]:
    return db.query(Permission).order_by(Permission.section, Permission.code).all()
