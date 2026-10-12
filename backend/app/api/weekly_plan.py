"""План недели (12.10, этап 3): состав, загрузка участков, утверждение,
запуск недели."""

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.security import get_permission_codes, require_permission
from app.db.session import get_db
from app.models.areas import Area
from app.models.plans import PLAN_APPROVED, PLAN_CHANGED, PLAN_DRAFT, PLAN_SUBMITTED, ProductionPlanEvent, ProductionPlanItem
from app.models.production_orders import ORDER_DRAFT
from app.models.roles import Permission, Role, role_permissions
from app.models.users import User, user_roles
from app.services import bitrix
from app.services import weekly_plan as wp
from app.services.planning import order_plan_status

router = APIRouter(prefix="/weekly-plan", tags=["weekly-plan"])
view = require_permission("production_tasks.manage", "production_tasks.view", "plan.approve", "orders.request")
manage = require_permission("production_tasks.manage")
approver = require_permission("plan.approve")


class PlanOrderOut(BaseModel):
    id: int
    name: str
    customer: str | None
    priority: int
    state: str  # запущен / принят / заявка
    qty: float
    promised_ready: date | None
    ship_date: date | None
    plan_finish: date | None
    plan_late: bool
    in_approved: bool  # был в утверждённой версии
    moved: bool  # даты отличаются от утверждённых
    load: dict[str, float]


class AreaLoadOut(BaseModel):
    area: str
    name: str
    by_day: list[float]
    capacity: list[float | None]


class EventOut(BaseModel):
    kind: str
    text: str
    user_name: str | None
    created_at: datetime


class PlanOut(BaseModel):
    week_start: date
    status: str
    version: int
    comment: str | None
    submitted_by_name: str | None
    submitted_at: datetime | None
    approved_by_name: str | None
    approved_at: datetime | None
    can_approve: bool
    can_manage: bool
    days: list[date]
    orders: list[PlanOrderOut]
    requests: list[PlanOrderOut]  # отправленные заявки на эту неделю — ждут приёма
    removed: list[str]  # были в утверждённой версии, теперь не в неделе
    areas: list[AreaLoadOut]
    events: list[EventOut]


def _name(db: Session, uid: int | None) -> str | None:
    u = db.get(User, uid) if uid else None
    return (u.full_name or u.username) if u else None


def _ws(week: date | None) -> date:
    return wp.week_start(week or date.today())


def _can(user: User, code: str) -> bool:
    return user.is_superuser or code in get_permission_codes(user)


@router.get("", response_model=PlanOut)
def get_week(week: date | None = Query(default=None), db: Session = Depends(get_db), user: User = Depends(view)) -> PlanOut:
    ws = _ws(week)
    plan = wp.get_plan(db, ws)
    all_orders = wp.week_orders(db, ws)
    orders = [o for o in all_orders if o.request_status != "submitted" or o.status != ORDER_DRAFT]
    requests = [o for o in all_orders if o not in orders]
    try:
        load = wp.week_load(db, ws, orders, user.id)
    finally:
        db.rollback()
    snap = {}
    if plan and plan.version:
        snap = {
            i.order_id: i for i in db.query(ProductionPlanItem).filter(ProductionPlanItem.plan_id == plan.id, ProductionPlanItem.version == plan.version)
        }

    def out(o) -> PlanOrderOut:
        ps = order_plan_status(db, o)
        s = snap.get(o.id)
        return PlanOrderOut(
            id=o.id, name=o.name, customer=o.customer, priority=o.priority or 0,
            state="запущен" if o.status != ORDER_DRAFT else ("принят" if o.request_status == "accepted" else "заявка"),
            qty=sum(float(ln.quantity) for ln in o.lines), promised_ready=o.promised_ready, ship_date=o.ship_date,
            plan_finish=ps.finish, plan_late=ps.late, in_approved=s is not None,
            moved=bool(s and (s.promised_ready != o.promised_ready or s.ship_date != o.ship_date)),
            load={k: round(v, 1) for k, v in load.by_order.get(o.id, {}).items()},
        )

    names = {a.code: a.name for a in db.query(Area)}
    areas = [
        AreaLoadOut(area=a, name=names.get(a, a), by_day=[round(load.areas[a].get(d, 0.0), 1) for d in load.days],
                    capacity=[load.capacity.get(a, {}).get(d) for d in load.days])
        for a in sorted(load.areas, key=lambda x: names.get(x, x))
    ]
    current = {o.id for o in all_orders}
    events = (
        db.query(ProductionPlanEvent).filter(ProductionPlanEvent.plan_id == plan.id).order_by(ProductionPlanEvent.id.desc()).limit(50).all()
        if plan else []
    )
    return PlanOut(
        week_start=ws, status=plan.status if plan else PLAN_DRAFT, version=plan.version if plan else 0,
        comment=plan.comment if plan else None,
        submitted_by_name=_name(db, plan.submitted_by) if plan else None, submitted_at=plan.submitted_at if plan else None,
        approved_by_name=_name(db, plan.approved_by) if plan else None, approved_at=plan.approved_at if plan else None,
        can_approve=_can(user, "plan.approve"), can_manage=_can(user, "production_tasks.manage"),
        days=load.days, orders=[out(o) for o in orders], requests=[out(o) for o in requests],
        removed=[f"№{i.order_id} «{i.order_name}»" for oid, i in snap.items() if oid not in current],
        areas=areas,
        events=[EventOut(kind=e.kind, text=e.text, user_name=_name(db, e.user_id), created_at=e.created_at) for e in events],
    )


class CommentIn(BaseModel):
    comment: str | None = Field(default=None, max_length=500)


def _approvers(db: Session) -> list[User]:
    q = (
        db.query(User)
        .join(user_roles, user_roles.c.user_id == User.id)
        .join(role_permissions, role_permissions.c.role_id == user_roles.c.role_id)
        .join(Permission, Permission.id == role_permissions.c.permission_id)
        .filter(Permission.code == "plan.approve", User.is_active.is_(True))
    )
    return q.distinct().all()


def _link(db: Session, ws: date) -> str:
    s = bitrix.get_settings(db)
    base = (s.get("base_url") or "").rstrip("/")
    title = f"План недели с {ws:%d.%m.%Y}"
    return f"[URL={base}/weekly-plan?week={ws.isoformat()}]{title}[/URL]" if base else title


@router.post("/{week}/submit", response_model=PlanOut)
def submit_week(week: date, payload: CommentIn, db: Session = Depends(get_db), user: User = Depends(manage)) -> PlanOut:
    ws = _ws(week)
    plan = wp.get_plan(db, ws, create=True)
    if plan.status == PLAN_SUBMITTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "План уже на утверждении")
    orders = [o for o in wp.week_orders(db, ws) if not (o.status == ORDER_DRAFT and o.request_status == "submitted")]
    wp.submit(db, plan, orders, user.id, (payload.comment or "").strip() or None)
    for a in _approvers(db):
        bitrix.message_to_user(db, "plan_submitted", a.id, f"На утверждение: {_link(db, ws)} — заказов {len(orders)}"
                               + (f"\nКомментарий: {plan.comment}" if plan.comment else ""))
    db.commit()
    return get_week(ws, db, user)


@router.post("/{week}/approve", response_model=PlanOut)
def approve_week(week: date, payload: CommentIn, db: Session = Depends(get_db), user: User = Depends(approver)) -> PlanOut:
    ws = _ws(week)
    plan = wp.get_plan(db, ws)
    if plan is None or plan.status not in (PLAN_SUBMITTED, PLAN_CHANGED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Утвердить можно план на утверждении или изменённый")
    orders = [o for o in wp.week_orders(db, ws) if not (o.status == ORDER_DRAFT and o.request_status == "submitted")]
    wp.approve(db, plan, orders, user.id, (payload.comment or "").strip() or None)
    bitrix.message_to_user(db, "plan_approved", plan.submitted_by, f"Утверждён: {_link(db, ws)}, версия {plan.version}"
                           + (f"\nКомментарий: {payload.comment}" if payload.comment else ""))
    db.commit()
    return get_week(ws, db, user)


@router.post("/{week}/return", response_model=PlanOut)
def return_week(week: date, payload: CommentIn, db: Session = Depends(get_db), user: User = Depends(approver)) -> PlanOut:
    ws = _ws(week)
    plan = wp.get_plan(db, ws)
    if plan is None or plan.status not in (PLAN_SUBMITTED, PLAN_CHANGED):
        raise HTTPException(status.HTTP_409_CONFLICT, "Вернуть можно план на утверждении или изменённый")
    comment = (payload.comment or "").strip()
    if not comment:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Напишите, что поправить")
    wp.return_plan(db, plan, user.id, comment)
    bitrix.message_to_user(db, "plan_returned", plan.submitted_by, f"Возвращён: {_link(db, ws)}\nЧто поправить: {comment}")
    db.commit()
    return get_week(ws, db, user)


class LaunchOut(BaseModel):
    launched: list[int]
    failed: list[str]


@router.post("/{week}/launch", response_model=LaunchOut)
def launch_week(week: date, db: Session = Depends(get_db), user: User = Depends(manage)) -> LaunchOut:
    """Запустить принятые заказы утверждённой недели — каждый своей
    транзакцией: что не запустилось, остаётся черновиком с причиной."""
    from app.api.production_orders import PfPickIn, ReleaseIn, release

    ws = _ws(week)
    plan = wp.get_plan(db, ws)
    if plan is None or plan.status != PLAN_APPROVED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Запускается только утверждённый план")
    launched, failed = [], []
    for o in wp.week_orders(db, ws):
        if o.status != ORDER_DRAFT or o.request_status != "accepted":
            continue
        picks = [PfPickIn(**p.__dict__) for p in wp.default_picks(db, o)]
        try:
            release(o.id, ReleaseIn(pf=picks), db, user)
            launched.append(o.id)
        except HTTPException as e:
            db.rollback()
            failed.append(f"№{o.id} «{o.name}»: {e.detail}")
    if launched:
        p = wp.get_plan(db, ws)
        wp.event(db, p, "launch", f"Запущено заказов: {len(launched)}" + (f"; не запустились: {len(failed)}" if failed else ""), user.id)
        db.commit()
    return LaunchOut(launched=launched, failed=failed)
