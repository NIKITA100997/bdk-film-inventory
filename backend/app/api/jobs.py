"""Эндпоинты контроля и скачивания результатов фоновых задач (воркера)."""

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.security import get_current_user
from app.models.users import User
from app.services.task_worker import get_job

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}")
def get_job_status(job_id: str, user: User = Depends(get_current_user)) -> dict:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задача не найдена")
    return {
        "job_id": job.job_id,
        "name": job.name,
        "status": job.status,
        "created_at": job.created_at.isoformat(),
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "result_meta": job.result_meta,
        "has_download": job.result_bytes is not None,
        "error": job.error,
    }


@router.get("/{job_id}/download")
def download_job_result(job_id: str, user: User = Depends(get_current_user)) -> Response:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Задача не найдена")
    if job.status in ("pending", "running"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Задача ещё выполняется")
    if job.status == "error":
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=job.error or "Ошибка выполнения")
    if job.result_bytes is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Файл результата отсутствует")
    headers = {}
    if job.filename:
        headers["Content-Disposition"] = f'inline; filename="{job.filename}"'
    return Response(
        content=job.result_bytes,
        media_type=job.content_type or "application/octet-stream",
        headers=headers,
    )
