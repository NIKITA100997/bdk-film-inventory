"""Закрытие периода и запросы администратору (07.10.2026) — модели в
models/control.py, проверка периода — services/period_guard.py."""

import json
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import create_action_token, get_current_user, get_permission_codes, require_permission
from app.db.session import get_db
from app.models.control import (
    PERIOD_CLOSE,
    PERIOD_REOPEN,
    REQ_DONE,
    REQ_EXECUTING,
    REQ_FAILED,
    REQ_PENDING,
    REQ_REJECTED,
    ActionRequest,
    PeriodClosing,
)
from app.models.users import User
from app.services import period_guard
from app.services.action_requests import ALLOWED_METHODS, DENIED_PREFIXES, MAX_BODY, describe, parse_body

router = APIRouter(tags=["control"])
manage_period = require_permission("period.manage")
approve_requests = require_permission("requests.approve")


def _names(db: Session) -> dict[int, str]:
    return {u.id: (u.full_name or u.username) for u in db.query(User)}


def can_approve(user: User) -> bool:
    return user.is_superuser or "requests.approve" in get_permission_codes(user)


# ---------- закрытие периода ----------
class PeriodRow(BaseModel):
    id: int
    closed_until: date | None
    action: str
    reason: str | None
    user_name: str | None
    created_at: datetime


class PeriodOut(BaseModel):
    closed_until: date | None
    history: list[PeriodRow]


class PeriodCloseIn(BaseModel):
    until: date
    reason: str | None = Field(default=None, max_length=255)


class PeriodReopenIn(BaseModel):
    until: date | None = None  # новая граница; пусто — всё открыто
    reason: str = Field(min_length=1, max_length=255)


def _period_out(db: Session) -> PeriodOut:
    names = _names(db)
    rows = db.query(PeriodClosing).order_by(PeriodClosing.id.desc()).limit(100).all()
    return PeriodOut(
        closed_until=rows[0].closed_until if rows else None,
        history=[
            PeriodRow(id=r.id, closed_until=r.closed_until, action=r.action, reason=r.reason, user_name=names.get(r.user_id),
                      created_at=r.created_at)
            for r in rows
        ],
    )


@router.get("/period-closing", response_model=PeriodOut)
def get_period(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> PeriodOut:
    return _period_out(db)


@router.post("/period-closing/close", response_model=PeriodOut)
def close_period(payload: PeriodCloseIn, db: Session = Depends(get_db), user: User = Depends(manage_period)) -> PeriodOut:
    """Закрыть период по дату включительно (обычно — последний день месяца)."""
    current = _period_out(db).closed_until
    if current is not None and payload.until <= current:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Период уже закрыт по {current:%d.%m.%Y}")
    if payload.until >= date.today():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Закрыть можно только прошедшие дни")
    db.add(PeriodClosing(closed_until=payload.until, action=PERIOD_CLOSE, reason=(payload.reason or "").strip() or None, user_id=user.id))
    db.commit()
    period_guard.invalidate()
    return _period_out(db)


@router.post("/period-closing/reopen", response_model=PeriodOut)
def reopen_period(payload: PeriodReopenIn, db: Session = Depends(get_db), user: User = Depends(manage_period)) -> PeriodOut:
    """Открыть период: граница сдвигается назад (или снимается совсем),
    причина обязательна — остаётся в истории."""
    current = _period_out(db).closed_until
    if current is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Закрытого периода нет")
    if payload.until is not None and payload.until >= current:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Новая граница должна быть раньше текущей")
    db.add(PeriodClosing(closed_until=payload.until, action=PERIOD_REOPEN, reason=payload.reason.strip(), user_id=user.id))
    db.commit()
    period_guard.invalidate()
    return _period_out(db)


# ---------- запросы администратору ----------
class RequestIn(BaseModel):
    method: str
    path: str = Field(max_length=500)
    body: object | None = None
    error: str | None = Field(default=None, max_length=500)
    kind: str = "forbidden"  # forbidden / period_closed
    page: str | None = Field(default=None, max_length=255)
    comment: str = Field(min_length=1, max_length=500)


class RequestOut(BaseModel):
    id: int
    method: str
    path: str
    summary: str
    error: str | None
    kind: str
    page: str | None
    comment: str
    status: str
    requested_by_name: str | None
    created_at: datetime
    resolved_by_name: str | None
    resolved_at: datetime | None
    result: str | None
    mine: bool


def _req_out(r: ActionRequest, names: dict[int, str], user: User) -> RequestOut:
    return RequestOut(
        id=r.id, method=r.method, path=r.path, summary=r.summary, error=r.error, kind=r.kind, page=r.page, comment=r.comment,
        status=r.status, requested_by_name=names.get(r.requested_by), created_at=r.created_at,
        resolved_by_name=names.get(r.resolved_by) if r.resolved_by else None, resolved_at=r.resolved_at, result=r.result,
        mine=r.requested_by == user.id,
    )


@router.post("/action-requests", response_model=RequestOut, status_code=status.HTTP_201_CREATED)
def create_request(payload: RequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> RequestOut:
    """«Попросить администратора»: действие, в котором отказали, — на
    подтверждение."""
    method = payload.method.upper()
    path = payload.path if payload.path.startswith("/api/") else "/api" + (payload.path if payload.path.startswith("/") else "/" + payload.path)
    if method not in ALLOWED_METHODS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Попросить можно только о действии, не о просмотре")
    if any(path.startswith(p) for p in DENIED_PREFIXES):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Это действие через запрос не выполняется — обратитесь к администратору напрямую")
    raw = json.dumps(payload.body, ensure_ascii=False) if payload.body is not None else None
    if raw is not None and len(raw) > MAX_BODY:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Слишком большой запрос")
    dup = (
        db.query(ActionRequest)
        .filter(ActionRequest.requested_by == user.id, ActionRequest.status == REQ_PENDING, ActionRequest.method == method,
                ActionRequest.path == path, ActionRequest.body == raw)
        .first()
    )
    if dup is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Такой запрос уже отправлен — ждите решения администратора")
    r = ActionRequest(
        method=method, path=path, body=raw, summary=describe(db, method, path, payload.body),
        error=payload.error, kind=payload.kind if payload.kind in ("forbidden", "period_closed") else "forbidden",
        page=payload.page, comment=payload.comment.strip(), status=REQ_PENDING, requested_by=user.id,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return _req_out(r, _names(db), user)


@router.get("/action-requests", response_model=list[RequestOut])
def list_requests(scope: str = "mine", db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[RequestOut]:
    """scope: mine — мои; pending — ждут решения; all — все (последние 300).
    pending и all — только тем, кто подтверждает."""
    q = db.query(ActionRequest)
    if scope == "mine":
        q = q.filter(ActionRequest.requested_by == user.id)
    else:
        if not can_approve(user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        if scope == "pending":
            q = q.filter(ActionRequest.status == REQ_PENDING)
    rows = q.order_by(ActionRequest.id.desc()).limit(300).all()
    if scope == "mine":
        changed = False
        for r in rows:
            if r.status not in (REQ_PENDING, REQ_EXECUTING) and not r.seen:
                r.seen = True
                changed = True
        if changed:
            db.commit()
    return [_req_out(r, _names(db), user) for r in rows]


class Summary(BaseModel):
    to_approve: int
    mine_resolved: int
    can_approve: bool


@router.get("/action-requests/summary", response_model=Summary)
def summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Summary:
    ok = can_approve(user)
    return Summary(
        to_approve=db.query(ActionRequest).filter(ActionRequest.status == REQ_PENDING).count() if ok else 0,
        mine_resolved=db.query(ActionRequest)
        .filter(ActionRequest.requested_by == user.id, ActionRequest.seen.is_(False),
                ActionRequest.status.in_([REQ_DONE, REQ_FAILED, REQ_REJECTED]))
        .count(),
        can_approve=ok,
    )


def _detail(resp) -> str:
    try:
        d = resp.json().get("detail")
    except ValueError:
        return resp.text[:300]
    if isinstance(d, str):
        return d
    return json.dumps(d, ensure_ascii=False)[:300]


@router.post("/action-requests/{request_id}/approve", response_model=RequestOut)
def approve(request_id: int, db: Session = Depends(get_db), user: User = Depends(approve_requests)) -> RequestOut:
    """Выполнить действие от имени администратора (с правом писать в
    закрытый период). Не получилось — запрос «не выполнен» с причиной."""
    r = db.get(ActionRequest, request_id)
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Запрос не найден")
    if r.status != REQ_PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запрос уже рассмотрен")
    r.status = REQ_EXECUTING
    r.resolved_by = user.id
    r.resolved_at = datetime.now(timezone.utc)
    db.commit()

    from app.main import app

    token = create_action_token(subject=user.username, request_id=r.id)
    body = parse_body(r.body)
    # без «with» — без запуска/остановки приложения, просто вызов
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.request(r.method, r.path, json=body if r.body else None, headers={"Authorization": f"Bearer {token}"})
    db.refresh(r)
    if resp.status_code < 300:
        r.status = REQ_DONE
        r.result = "Выполнено"
    else:
        r.status = REQ_FAILED
        r.result = f"Не выполнено: {_detail(resp)}"[:500]
    db.commit()
    db.refresh(r)
    return _req_out(r, _names(db), user)


class RejectIn(BaseModel):
    reason: str = Field(min_length=1, max_length=400)


@router.post("/action-requests/{request_id}/reject", response_model=RequestOut)
def reject(request_id: int, payload: RejectIn, db: Session = Depends(get_db), user: User = Depends(approve_requests)) -> RequestOut:
    r = db.get(ActionRequest, request_id)
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Запрос не найден")
    if r.status != REQ_PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запрос уже рассмотрен")
    r.status = REQ_REJECTED
    r.resolved_by = user.id
    r.resolved_at = datetime.now(timezone.utc)
    r.result = f"Отклонено: {payload.reason.strip()}"[:500]
    db.commit()
    db.refresh(r)
    return _req_out(r, _names(db), user)
