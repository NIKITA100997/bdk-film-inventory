from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.width_analogs import WidthAnalogGroup, WidthAnalogMember
from app.schemas.width_analogs import WidthAnalogGroupCreate, WidthAnalogGroupOut, WidthAnalogGroupUpdate

router = APIRouter(tags=["width-analogs"])

# Раздел про аналоги ширин при выдаче — то же право, что у прочих
# словарных админок похожего веса решения (материалы/причины списания).
manage_width_analogs = require_permission("materials.manage")


def _with_members(query):
    return query.options(joinedload(WidthAnalogGroup.members))


@router.get("/width-analogs", response_model=list[WidthAnalogGroupOut])
def list_width_analog_groups(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[WidthAnalogGroup]:
    """Открыто любому авторизованному — читает и админка, и ручной подбор
    донора в "Выдаче" (подсветить аналог как подходящий), не только тот,
    кто администрирует группы."""
    return _with_members(db.query(WidthAnalogGroup)).order_by(WidthAnalogGroup.id).all()


def _check_widths_free(db: Session, widths: list[float], *, exclude_group_id: int | None = None) -> None:
    if len(set(widths)) != len(widths):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ширина повторяется в списке")
    query = db.query(WidthAnalogMember).filter(WidthAnalogMember.width_mm.in_(widths))
    if exclude_group_id is not None:
        query = query.filter(WidthAnalogMember.group_id != exclude_group_id)
    clash = query.first()
    if clash is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Ширина {clash.width_mm} мм уже состоит в другой группе аналогов"
        )


@router.post("/width-analogs", response_model=WidthAnalogGroupOut, status_code=status.HTTP_201_CREATED)
def create_width_analog_group(
    payload: WidthAnalogGroupCreate, db: Session = Depends(get_db), user=Depends(manage_width_analogs)
) -> WidthAnalogGroup:
    _check_widths_free(db, payload.widths)
    group = WidthAnalogGroup(note=payload.note)
    group.members = [WidthAnalogMember(width_mm=w) for w in payload.widths]
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


@router.patch("/width-analogs/{group_id}", response_model=WidthAnalogGroupOut)
def update_width_analog_group(
    group_id: int, payload: WidthAnalogGroupUpdate, db: Session = Depends(get_db), user=Depends(manage_width_analogs)
) -> WidthAnalogGroup:
    group = db.get(WidthAnalogGroup, group_id)
    if group is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Группа не найдена")
    _check_widths_free(db, payload.widths, exclude_group_id=group_id)
    group.note = payload.note
    # Явное DELETE + flush до INSERT новых строк, а не просто
    # переприсвоение group.members — иначе на пересечении старого и
    # нового состава (например, обе версии включают 285мм) ORM в одном
    # flush пытается вставить новую строку раньше, чем физически удалить
    # старую, и падает по uq_width_analog_member_width.
    db.query(WidthAnalogMember).filter(WidthAnalogMember.group_id == group_id).delete()
    db.flush()
    for w in payload.widths:
        db.add(WidthAnalogMember(group_id=group_id, width_mm=w))
    db.commit()
    db.refresh(group)
    return group


@router.delete("/width-analogs/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_width_analog_group(
    group_id: int, db: Session = Depends(get_db), user=Depends(manage_width_analogs)
) -> None:
    group = db.get(WidthAnalogGroup, group_id)
    if group is not None:
        db.delete(group)
        db.commit()
