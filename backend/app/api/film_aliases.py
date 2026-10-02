"""Сопоставления плёнки — общий справочник «текст из внешнего источника →
плёнка» (графики запуска, наряды, планы заготовок, 1С). Читают все, кто
работает с загрузками; правят — справочники материалов или начальник цеха."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.dictionaries import Color, Material, MaterialSku, Thickness
from app.models.film_aliases import FilmAlias
from app.models.users import User
from app.services.film_aliases import alias_key, alias_skus

router = APIRouter(tags=["film-aliases"])
manage_aliases = require_permission("materials.manage", "production_tasks.manage")


class FilmAliasOut(BaseModel):
    id: int
    text: str
    film: str
    material_sku_id: int | None  # одна из позиций плёнки — для выбора в форме
    any_thickness: bool
    source: str | None
    has_stock_sku: bool  # плёнка есть в справочнике активной позицией


class FilmAliasIn(BaseModel):
    text: str
    material_sku_id: int
    # True — любая толщина этой плёнки (у сопоставления без толщины)
    any_thickness: bool = False
    source: str | None = None


def _out(db: Session, a: FilmAlias) -> FilmAliasOut:
    m, c = db.get(Material, a.material_id), db.get(Color, a.color_id)
    t = db.get(Thickness, a.thickness_id) if a.thickness_id else None
    skus = alias_skus(db, a)
    return FilmAliasOut(
        id=a.id, text=a.text,
        film=f"{m.name if m else '?'} {c.name if c else '?'}" + (f" {float(t.value_mm):g} мм" if t else ""),
        material_sku_id=skus[0].id if skus else None, any_thickness=a.thickness_id is None,
        source=a.source, has_stock_sku=bool(skus),
    )


@router.get("/film-aliases", response_model=list[FilmAliasOut])
def list_aliases(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[FilmAliasOut]:
    return [_out(db, a) for a in db.query(FilmAlias).order_by(FilmAlias.text)]


def _apply(db: Session, a: FilmAlias, payload: FilmAliasIn) -> None:
    sku = db.get(MaterialSku, payload.material_sku_id)
    if sku is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Плёнка не найдена")
    key = alias_key(payload.text)
    if not key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Пустой текст сопоставления")
    other = db.query(FilmAlias).filter(FilmAlias.key == key, FilmAlias.id != (a.id or 0)).first()
    if other is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"«{payload.text}» уже сопоставлен: «{other.text}»")
    a.text, a.key = payload.text.strip()[:255], key[:255]
    a.material_id, a.color_id = sku.material_id, sku.color_id
    a.thickness_id = None if payload.any_thickness else sku.thickness_id
    a.source = payload.source if payload.source is not None else a.source


@router.post("/film-aliases", response_model=FilmAliasOut, status_code=status.HTTP_201_CREATED)
def create_alias(payload: FilmAliasIn, db: Session = Depends(get_db), user: User = Depends(manage_aliases)) -> FilmAliasOut:
    a = FilmAlias(created_by=user.id, source=payload.source or "вручную")
    _apply(db, a, payload)
    db.add(a)
    db.commit()
    return _out(db, a)


@router.patch("/film-aliases/{alias_id}", response_model=FilmAliasOut)
def update_alias(alias_id: int, payload: FilmAliasIn, db: Session = Depends(get_db), user: User = Depends(manage_aliases)) -> FilmAliasOut:
    a = db.get(FilmAlias, alias_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сопоставление не найдено")
    _apply(db, a, payload)
    db.commit()
    return _out(db, a)


@router.delete("/film-aliases/{alias_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_alias(alias_id: int, db: Session = Depends(get_db), user: User = Depends(manage_aliases)) -> None:
    a = db.get(FilmAlias, alias_id)
    if a is not None:
        db.delete(a)
        db.commit()
