"""«Общее» (28.10): набор рабочих модулей главной у пользователя — на сервере,
одинаковый на всех его устройствах. Пусто — стандартный набор по ролям
(считает интерфейс: там же и каталог модулей)."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.users import User

router = APIRouter(prefix="/home", tags=["home"])


class HomeOut(BaseModel):
    modules: list[str] | None


class HomeIn(BaseModel):
    # None — вернуть стандартный набор
    modules: list[str] | None = Field(default=None, max_length=40)


@router.get("", response_model=HomeOut)
def get_home(user: User = Depends(get_current_user)) -> HomeOut:
    return HomeOut(modules=user.home_modules)


@router.put("", response_model=HomeOut)
def set_home(payload: HomeIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> HomeOut:
    """Свой набор — сам (решение 28.10); чужой не меняется."""
    me = db.get(User, user.id)
    me.home_modules = list(dict.fromkeys(m[:64] for m in payload.modules)) if payload.modules is not None else None
    db.commit()
    return HomeOut(modules=me.home_modules)
