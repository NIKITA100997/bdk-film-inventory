"""«Ждёт меня» (28.10): что ждёт действия этого пользователя — по его
правам, живым расчётом из данных (ничего не отмечается вручную и не
устаревает). Один список на главной и счётчик в шапке: горизонтальные
связи — менеджер завёл заказ, производство видит, что его надо принять."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import get_current_user, get_permission_codes
from app.db.session import get_db
from app.models.users import User

router = APIRouter(prefix="/inbox", tags=["inbox"])


class InboxItem(BaseModel):
    key: str
    title: str
    count: int
    link: str
    hint: str | None = None
    # urgent — ждут давно или срочное; normal — обычная очередь
    level: str = "normal"


def _can(user: User, *codes: str) -> bool:
    return user.is_superuser or bool(get_permission_codes(user) & set(codes))


def collect(db: Session, user: User) -> list[InboxItem]:
    from app.models.customer_orders import CO_ACCEPTED, CO_DRAFT, CO_RETURNED, CO_SUBMITTED, CustomerOrder

    out: list[InboxItem] = []
    # заказы — тем, кто ведёт производство целиком; начальник одного участка
    # (участок в профиле, без «всех участков») видит дела своего участка
    production = _can(user, "production_tasks.manage") and (not user.area or _can(user, "production_tasks.all_areas"))

    # ---- заказы клиентов ----
    if production:
        sent = db.query(CustomerOrder).filter(CustomerOrder.status == CO_SUBMITTED).count()
        if sent:
            out.append(InboxItem(key="co_submitted", title="Заказы клиентов ждут приёма", count=sent,
                                 link="/customer-orders?section=intake", level="urgent",
                                 hint="менеджер отправил в производство — принять с датами или вернуть"))
        drafts = db.query(CustomerOrder).filter(CustomerOrder.status == CO_DRAFT).count()
        if drafts:
            out.append(InboxItem(key="co_drafts", title="Черновики заказов клиентов не отправлены", count=drafts,
                                 link="/customer-orders?section=intake",
                                 hint="производство может принять и черновик — «Приём в производство»"))
        from app.services.customer_orders import progress

        unlaunched = 0
        for co in db.query(CustomerOrder).filter(CustomerOrder.status == CO_ACCEPTED):
            p = progress(db, co)
            if p.launched < p.qty - 0.001:
                unlaunched += 1
        if unlaunched:
            out.append(InboxItem(key="co_unlaunched", title="Принятые заказы клиентов без запуска", count=unlaunched,
                                 link="/customer-orders?filter=accepted",
                                 hint="отметьте и «Собрать запуск» — заказ на производство"))
    if _can(user, "orders.request") and not production:
        mine = db.query(CustomerOrder).filter(CustomerOrder.manager_id == user.id)
        my_drafts = mine.filter(CustomerOrder.status == CO_DRAFT).count()
        if my_drafts:
            out.append(InboxItem(key="co_my_drafts", title="Мои заказы не отправлены в производство", count=my_drafts,
                                 link="/customer-orders?filter=mine", level="urgent",
                                 hint="производство их не видит в очереди, пока не отправите"))
    if _can(user, "orders.request"):
        returned = (
            db.query(CustomerOrder)
            .filter(CustomerOrder.status == CO_RETURNED, CustomerOrder.manager_id == user.id)
            .count()
        )
        if returned:
            out.append(InboxItem(key="co_returned", title="Мои заказы вернули с замечаниями", count=returned,
                                 link="/customer-orders?filter=mine", level="urgent"))

    # ---- заказы на производство ----
    if production:
        from app.models.production_orders import ORDER_DRAFT, ProductionOrder

        po_drafts = db.query(ProductionOrder).filter(ProductionOrder.status == ORDER_DRAFT).count()
        if po_drafts:
            out.append(InboxItem(key="po_drafts", title="Заказы на производство не запущены", count=po_drafts,
                                 link="/production-orders", hint="черновики — запустите или удалите"))

    # ---- план недели ----
    if _can(user, "plan.approve"):
        from app.models.plans import PLAN_CHANGED, PLAN_SUBMITTED, ProductionPlan

        plans = db.query(ProductionPlan).filter(ProductionPlan.status.in_([PLAN_SUBMITTED, PLAN_CHANGED])).count()
        if plans:
            out.append(InboxItem(key="plan_approve", title="План недели ждёт утверждения", count=plans,
                                 link="/planning?section=week", level="urgent"))

    # ---- заявки участков (выдача) ----
    if _can(user, "units.issue", "production_tasks.manage"):
        from app.api.area_supply import _own_area
        from app.models.area_supply import REQ_NEW, AreaRequest

        q = db.query(AreaRequest).filter(AreaRequest.status == REQ_NEW)
        own = _own_area(db, user)
        if own:
            q = q.filter(AreaRequest.area == own)
        n = q.count()
        if n:
            out.append(InboxItem(key="area_requests", title="Новые заявки участков", count=n,
                                 link="/production-tasks?tab=film-issue&sub=requests"))

    # ---- закупки ----
    if _can(user, "purchasing.manage"):
        from app.models.purchasing import PurchaseRequest

        n = db.query(PurchaseRequest).filter(PurchaseRequest.status == "open", PurchaseRequest.order_id.is_(None)).count()
        if n:
            out.append(InboxItem(key="purchase_requests", title="Заявки на закупку без заказа поставщику", count=n,
                                 link="/purchasing"))

    # ---- инвентаризация ----
    from app.services.stock_counts import PLACE_KINDS

    count_codes = {c for kinds in PLACE_KINDS.values() for _, codes in kinds for c in codes}
    if _can(user, *count_codes):
        from app.models.part_counts import COUNT_IN_PROGRESS, PartCountSession

        n = db.query(PartCountSession).filter(PartCountSession.status == COUNT_IN_PROGRESS).count()
        if n:
            out.append(InboxItem(key="counts", title="Начатые инвентаризации", count=n, link="/inventory",
                                 hint="досчитать и закрыть — до закрытия остатки не поправлены"))

    # ---- запросы администратору ----
    from app.api.control import can_approve
    from app.models.control import REQ_PENDING, ActionRequest

    if can_approve(user):
        n = db.query(ActionRequest).filter(ActionRequest.status == REQ_PENDING).count()
        if n:
            out.append(InboxItem(key="action_requests", title="Запросы администратору", count=n,
                                 link="/requests?section=actions", level="urgent"))

    # ---- мастер участка ----
    if user.area and _can(user, "production_tasks.report") and not _can(user, "production_tasks.all_areas"):
        from app.models.production import ProductionTask, ProductionTaskLine

        n = (
            db.query(ProductionTaskLine)
            .join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id)
            .filter(ProductionTask.is_active.is_(True), ProductionTask.area == user.area,
                    ProductionTaskLine.production_closed.is_(False), ProductionTaskLine.is_closed.is_(False))
            .count()
        )
        if n:
            out.append(InboxItem(key="area_lines", title="Открытые строки заданий участка", count=n,
                                 link="/production-tasks", hint="сдать отчёт по сделанному"))
    return out


@router.get("", response_model=list[InboxItem])
def get_inbox(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[InboxItem]:
    return collect(db, user)
