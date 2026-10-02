"""Общие сопоставления «текст → плёнка» (models/film_aliases.py). Ключ —
текст без пояснения в скобках, регистра и ё: «ПЭТ Бежевый (cream silk)» и
«пэт бежевый» — одно и то же."""

import re

from sqlalchemy.orm import Session, joinedload

from app.models.dictionaries import MaterialSku
from app.models.film_aliases import FilmAlias


def alias_key(text: str) -> str:
    return " ".join(re.sub(r"\(.*?\)", " ", text or "").lower().replace("ё", "е").split())


def find_alias(db: Session, text: str) -> FilmAlias | None:
    key = alias_key(text)
    return db.query(FilmAlias).filter(FilmAlias.key == key).first() if key else None


def alias_skus(db: Session, alias: FilmAlias) -> list[MaterialSku]:
    """Активные позиции плёнки сопоставления (производителей может быть несколько)."""
    q = (
        db.query(MaterialSku)
        .options(joinedload(MaterialSku.material), joinedload(MaterialSku.color), joinedload(MaterialSku.thickness))
        .filter(MaterialSku.material_id == alias.material_id, MaterialSku.color_id == alias.color_id, MaterialSku.is_active.is_(True))
    )
    if alias.thickness_id is not None:
        q = q.filter(MaterialSku.thickness_id == alias.thickness_id)
    return q.order_by(MaterialSku.id).all()


def alias_map(db: Session) -> dict[str, MaterialSku]:
    """Ключ → позиция плёнки (первая активная) — для подбора в загрузчиках."""
    out: dict[str, MaterialSku] = {}
    for a in db.query(FilmAlias):
        skus = alias_skus(db, a)
        if skus:
            out[a.key] = skus[0]
    return out


def save_alias(
    db: Session, text: str, material_id: int, color_id: int, thickness_id: int | None,
    source: str | None = None, user_id: int | None = None,
) -> FilmAlias | None:
    """Записать сопоставление (есть — обновить плёнку). Пустой ключ — None."""
    key = alias_key(text)
    if not key:
        return None
    a = db.query(FilmAlias).filter(FilmAlias.key == key).first()
    if a is None:
        a = FilmAlias(text=text.strip()[:255], key=key[:255], material_id=material_id, color_id=color_id,
                      thickness_id=thickness_id, source=source, created_by=user_id)
        db.add(a)
    else:
        a.material_id, a.color_id, a.thickness_id = material_id, color_id, thickness_id
    db.flush()
    return a
