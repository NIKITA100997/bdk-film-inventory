from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_permission
from app.db.session import get_db
from app.models.write_off_reasons import WriteOffReasonEntry
from app.schemas.write_off_reasons import WriteOffReasonCreate, WriteOffReasonOut, WriteOffReasonUpdate
from app.services.write_off_reasons import unique_reason_code

router = APIRouter(tags=["write-off-reasons"])

# Причины брака/списания (раздел про администрирование причин) — тот же
# логист/руководитель, что и остальными справочниками (материалы/цвета/
# толщины), отдельное право не заводим.
manage_reasons = require_permission("materials.manage")


@router.get("/write-off-reasons", response_model=list[WriteOffReasonOut])
def list_reasons(db: Session = Depends(get_db), user=Depends(get_current_user)) -> list[WriteOffReasonEntry]:
    """Активные и не системные — ровно то, что должно попасть в выпадающий
    список формы списания единицы/брака в производстве. "Отход при
    раскрое" (is_system=True) сюда не попадает ни при каком is_active —
    выставляется только автоматически при раскрое (units.py::split_unit)."""
    return (
        db.query(WriteOffReasonEntry)
        .filter(WriteOffReasonEntry.is_active.is_(True), WriteOffReasonEntry.is_system.is_(False))
        .order_by(WriteOffReasonEntry.name)
        .all()
    )


@router.get("/write-off-reasons/all", response_model=list[WriteOffReasonOut])
def list_all_reasons(db: Session = Depends(get_db), user=Depends(manage_reasons)) -> list[WriteOffReasonEntry]:
    """Всё, включая архив и системную — для экрана администрирования."""
    return db.query(WriteOffReasonEntry).order_by(WriteOffReasonEntry.name).all()


@router.post("/write-off-reasons", response_model=WriteOffReasonOut, status_code=status.HTTP_201_CREATED)
def create_reason(
    payload: WriteOffReasonCreate, db: Session = Depends(get_db), user=Depends(manage_reasons)
) -> WriteOffReasonEntry:
    if db.query(WriteOffReasonEntry).filter(WriteOffReasonEntry.name == payload.name).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Причина с таким названием уже есть")
    reason = WriteOffReasonEntry(code=unique_reason_code(db, payload.name), name=payload.name, is_active=True)
    db.add(reason)
    db.commit()
    db.refresh(reason)
    return reason


@router.patch("/write-off-reasons/{code}", response_model=WriteOffReasonOut)
def update_reason(
    code: str, payload: WriteOffReasonUpdate, db: Session = Depends(get_db), user=Depends(manage_reasons)
) -> WriteOffReasonEntry:
    reason = db.get(WriteOffReasonEntry, code)
    if reason is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Причина не найдена")
    if payload.name is not None:
        if db.query(WriteOffReasonEntry).filter(WriteOffReasonEntry.name == payload.name, WriteOffReasonEntry.code != code).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Причина с таким названием уже есть")
        reason.name = payload.name
    if payload.is_active is not None:
        reason.is_active = payload.is_active
    db.commit()
    db.refresh(reason)
    return reason
