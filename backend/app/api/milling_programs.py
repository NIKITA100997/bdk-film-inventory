"""Справочник программ фрезеровки панелей (07.10.2026)."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.milling_programs import MillingProgram
from app.models.users import User
from app.services.milling_programs import parse_program

router = APIRouter(prefix="/milling-programs", tags=["milling-programs"])
manage = require_permission("materials.manage", "production_tasks.manage")


class ProgramOut(BaseModel):
    id: int
    name: str
    note: str | None
    is_active: bool
    series: str | None
    version: str | None
    width: int | None
    molding: str | None
    variant: int | None


class ProgramIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    note: str | None = Field(default=None, max_length=255)


class ProgramPatch(BaseModel):
    note: str | None = Field(default=None, max_length=255)
    is_active: bool | None = None


def _out(p: MillingProgram) -> ProgramOut:
    s = parse_program(p.name)
    return ProgramOut(id=p.id, name=p.name, note=p.note, is_active=p.is_active, series=s.series if s else None,
                      version=s.version if s else None, width=s.width if s else None, molding=s.molding if s else None,
                      variant=s.variant if s else None)


@router.get("", response_model=list[ProgramOut])
def list_programs(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ProgramOut]:
    return [_out(p) for p in db.query(MillingProgram).order_by(MillingProgram.name)]


@router.post("", response_model=ProgramOut, status_code=status.HTTP_201_CREATED)
def add_program(payload: ProgramIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> ProgramOut:
    name = payload.name.strip()
    if db.query(MillingProgram).filter(func.lower(MillingProgram.name) == name.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Такая программа уже есть")
    p = MillingProgram(name=name, note=(payload.note or "").strip() or None, is_active=True)
    db.add(p)
    db.commit()
    db.refresh(p)
    return _out(p)


@router.patch("/{program_id}", response_model=ProgramOut)
def patch_program(program_id: int, payload: ProgramPatch, db: Session = Depends(get_db), user: User = Depends(manage)) -> ProgramOut:
    p = db.get(MillingProgram, program_id)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Программа не найдена")
    if payload.note is not None:
        p.note = payload.note.strip() or None
    if payload.is_active is not None:
        p.is_active = payload.is_active
    db.commit()
    db.refresh(p)
    return _out(p)


# ── Привязка программ к изделиям (20.10): вручную, главнее автоподбора ──


class BindingOut(BaseModel):
    item_id: int
    item_name: str
    programs: list[str]


class BindingIn(BaseModel):
    # одна — обе стороны, две — сторона 1 и 2; пусто — убрать привязку
    programs: list[str] = Field(default_factory=list, max_length=2)


@router.get("/bindings", response_model=list[BindingOut])
def list_bindings(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[BindingOut]:
    from app.models.items import Item

    return [
        BindingOut(item_id=i.id, item_name=i.name, programs=list(i.milling_programs or []))
        for i in db.query(Item).filter(Item.milling_programs.isnot(None)).order_by(Item.name)
        if i.milling_programs
    ]


@router.put("/bindings/{item_id}", response_model=BindingOut)
def set_binding(item_id: int, payload: BindingIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> BindingOut:
    from app.models.items import Item

    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Позиция не найдена")
    names = [n.strip() for n in payload.programs if n and n.strip()]
    known = {p.name for p in db.query(MillingProgram).filter(MillingProgram.name.in_(names or ["-"]))}
    missing = [n for n in names if n not in known]
    if missing:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Нет в справочнике программ: {', '.join(missing)}")
    item.milling_programs = names or None
    db.commit()
    return BindingOut(item_id=item.id, item_name=item.name, programs=names)
