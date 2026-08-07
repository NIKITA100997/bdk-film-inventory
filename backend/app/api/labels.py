from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.units import MaterialUnit
from app.services.labels import render_label_html

router = APIRouter(prefix="/labels", tags=["labels"])


@router.get("/{unit_id}", response_class=HTMLResponse, dependencies=[Depends(get_current_user)])
def get_label(unit_id: int, db: Session = Depends(get_db)) -> str:
    unit = db.get(MaterialUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Единица не найдена")
    return render_label_html(unit)
