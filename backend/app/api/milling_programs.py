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
