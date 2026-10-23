from datetime import date, datetime, timedelta, timezone

from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.abc import CalcSettings
from app.models.dictionaries import Color, Material, Thickness
from app.models.events import EventType, MaterialEvent
from app.models.production import ProductionTask, ProductionTaskLine, ProductionTaskLineReport
from app.models.purchasing import PurchaseRequest, Supplier
from app.models.units import MaterialSku, MaterialUnit, UnitStatus
from app.models.users import User
from app.schemas.deletion_requests import DeleteResultOut
from app.schemas.purchasing import (
    PurchaseRequestCreate,
    PurchaseRequestFulfillRequest,
    PurchaseRequestOut,
    PurchaseRequestShopFloorCreate,
    PurchaseRequestUpdate,
    StockForSkuOut,
    StockForSkusRequest,
    StockOverviewLine,
)
from app.services import normatives
from app.services.deletion_requests import request_deletion
from app.services.dictionaries import current_stock_m2, find_or_create_material_color_thickness, find_or_create_supplier
from app.services.panel_film import panel_film_by_group, panel_film_demand
from app.services.production import TaskLineForReserve, calc_default_strip_width, reserved_area_m2_by_group
from app.services.purchasing import ReorderInput, compute_reorder_signal
from app.services.suppliers import ClosedRequestRecord, compute_supplier_stats

router = APIRouter(prefix="/purchase-requests", tags=["purchasing"])

manage_purchasing = require_permission("purchasing.manage")
# Раздел про калькулятор заказа продажника — остаток/резерв по конкретной
# позиции нужен и снабженцу, и продажнику, но не более широкие права друг
# друга (продажник не получает purchasing.manage, снабженец как раньше).
view_stock_for_sales = require_permission("purchasing.manage", "sales_calculator.view")
# С "Выдачи участку" (units.issue) — сигнал нехватки прямо в моменте
# выдачи; с "Приёмки" (units.receive) — привязка заявки к конкретной
# поставке по УПД. Ни то ни другое не требует прав снабженца.
create_shop_floor_request = require_permission("units.issue", "sales_calculator.view")
fulfill_purchase_request_perm = require_permission("units.receive")


def _out(db: Session, req: PurchaseRequest) -> PurchaseRequestOut:
    if req.item_id is not None:
        # позиция не-плёнка (14.10): материал, комплектующее…
        from app.models.items import Item
        from app.services import materials as mat

        it = db.get(Item, req.item_id)
        film: dict = {
            "item_id": req.item_id, "item_name": it.name if it else f"#{req.item_id}",
            "quantity": float(req.quantity or 0), "unit": (it.unit or (it.kind.unit if it and it.kind else None)) if it else None,
            "current_stock": round(float(mat.balances(db, [req.item_id]).get(req.item_id, 0.0)), 3),
            "price_per_unit": float(req.price_per_unit) if req.price_per_unit is not None else None,
        }
    else:
        film = {
            "material": db.get(Material, req.material_id).name,
            "color": db.get(Color, req.color_id).name,
            "thickness": float(db.get(Thickness, req.thickness_id).value_mm),
            "requested_area_m2": float(req.requested_area_m2),
            "requested_length_m": float(req.requested_length_m) if req.requested_length_m is not None else None,
            "width_mm": float(req.width_mm) if req.width_mm is not None else None,
            "current_stock_m2": current_stock_m2(db, material_id=req.material_id, color_id=req.color_id, thickness_id=req.thickness_id),
        }
    return PurchaseRequestOut(
        id=req.id,
        **film,
        note=req.note,
        status=req.status,
        origin=req.origin,
        linked_upd_number=req.linked_upd_number,
        created_by=req.created_by,
        created_at=req.created_at,
        closed_at=req.closed_at,
        supplier=db.get(Supplier, req.supplier_id).name if req.supplier_id else None,
        price_per_m2=float(req.price_per_m2) if req.price_per_m2 is not None else None,
        promised_delivery_date=req.promised_delivery_date,
        order_id=req.order_id,
        need_by=req.need_by,
    )


def _stock_and_reserve_by_group(
    db: Session, panel_by_group: dict | None = None,
) -> tuple[dict[tuple[int, int, int], float], dict[tuple[int, int, int], float]]:
    """Остаток на складе и резерв на текущие незавершённые задания цеха, по
    группе материал+цвет+толщина — общий расчёт для «Остатки и резерв»
    снабженца (`stock_overview`) и для видимости остатков в калькуляторе
    заказа продажника (`stock_for_skus`), чтобы не дублировать нетривиальный
    запрос резерва в двух местах."""
    stock_rows = (
        db.query(
            MaterialSku.material_id,
            MaterialSku.color_id,
            MaterialSku.thickness_id,
            func.sum(MaterialUnit.width_mm * MaterialUnit.length_m / 1000),
        )
        .join(MaterialUnit, MaterialUnit.material_sku_id == MaterialSku.id)
        # неликвид (23.10) не в «доступно» и «заказать» — иначе маскировал бы нехватку цвета
        .filter(MaterialUnit.status != UnitStatus.SPISAN, MaterialUnit.marked_illiquid.is_(False))
        .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id)
        .all()
    )
    stock_by_group = {(m, c, t): round(float(area or 0), 3) for m, c, t, area in stock_rows}

    # Раздел про обратную связь — резерв должен считаться только по
    # активным заданиям цеха ("текущие незавершённые"): без этого фильтра
    # архивное задание с недоотчитанными деталями (никто их уже не
    # производит) навсегда оставалось бы "резервом", раздувая цифру и
    # занижая видимое "доступно" на ровно столько же (реальный случай —
    # архивное "Окутка МК заказ 24.08" держало в резерве 863 детали).
    lines = db.query(ProductionTaskLine).join(ProductionTask, ProductionTask.id == ProductionTaskLine.task_id).filter(
        ProductionTask.is_active
    ).all()
    line_ids = [line.id for line in lines]
    good_by_line: dict[int, float] = {}
    if line_ids:
        for line_id, good in (
            db.query(ProductionTaskLineReport.task_line_id, func.coalesce(func.sum(ProductionTaskLineReport.good_pieces), 0))
            .filter(ProductionTaskLineReport.task_line_id.in_(line_ids))
            .group_by(ProductionTaskLineReport.task_line_id)
            .all()
        ):
            good_by_line[line_id] = float(good)
    reserve_input = [
        TaskLineForReserve(
            material_id=line.material_id,
            color_id=line.color_id,
            thickness_id=line.thickness_id,
            quantity_pieces=float(line.quantity_pieces),
            produced_good_pieces=good_by_line.get(line.id, 0.0),
            length_m=float(line.length_m),
            effective_strip_width_mm=(
                float(line.strip_width_mm)
                if line.strip_width_mm is not None
                else calc_default_strip_width(line.part_name, float(line.width_mm))
            ),
        )
        for line in lines
        if line.material_id is not None and not line.use_illiquid  # «из неликвида» резервирует неликвид (23.10)
    ]
    reserved_by_group = reserved_area_m2_by_group(reserve_input)
    # Плёнка под ламинацию панелей заказанных дверей — тоже резерв.
    # panel_by_group — уже посчитанный вызывающим (14.10: считался дважды за запрос)
    for group, area in (panel_film_by_group(panel_film_demand(db)) if panel_by_group is None else panel_by_group).items():
        reserved_by_group[group] = round(reserved_by_group.get(group, 0.0) + area, 3)
    return stock_by_group, reserved_by_group


@router.get("/stock-overview", response_model=list[StockOverviewLine])
def stock_overview(db: Session = Depends(get_db), user: User = Depends(manage_purchasing)) -> list[StockOverviewLine]:
    """«Остатки и резерв» (раздел про экран снабженца) — остаток на складе,
    резерв на текущие незавершённые задания цеха и сколько уже в открытых
    заявках, по группе материал+цвет+толщина. Отдаётся тут, а не в
    reports.py, потому что снабженцу не выдаются права на задания цеха
    (production_tasks.*) — расчёт резерва идёт под её же правом
    purchasing.manage, без обращения к производственным эндпоинтам."""
    panel_by_group = panel_film_by_group(panel_film_demand(db))
    stock_by_group, reserved_by_group = _stock_and_reserve_by_group(db, panel_by_group)

    open_requested_rows = (
        db.query(
            PurchaseRequest.material_id,
            PurchaseRequest.color_id,
            PurchaseRequest.thickness_id,
            func.sum(PurchaseRequest.requested_area_m2),
        )
        .filter(PurchaseRequest.status == "open", PurchaseRequest.material_id.isnot(None))
        .group_by(PurchaseRequest.material_id, PurchaseRequest.color_id, PurchaseRequest.thickness_id)
        .all()
    )
    open_requested_by_group = {(m, c, t): round(float(area or 0), 2) for m, c, t, area in open_requested_rows}

    # "Обычно берут у" — эвристика по истории заявок (последний непустой
    # поставщик для этой группы), не жёсткая связка поставщик↔номенклатура.
    supplier_history_rows = (
        db.query(PurchaseRequest.material_id, PurchaseRequest.color_id, PurchaseRequest.thickness_id, PurchaseRequest.supplier_id)
        .filter(PurchaseRequest.supplier_id.is_not(None), PurchaseRequest.material_id.isnot(None))
        .order_by(PurchaseRequest.created_at.desc())
        .all()
    )
    usual_supplier_id_by_group: dict[tuple[int, int, int], int] = {}
    for m, c, t, supplier_id in supplier_history_rows:
        usual_supplier_id_by_group.setdefault((m, c, t), supplier_id)

    # Точка дозаказа по расходу (раздел про закупки на опережение) —
    # скорость расхода за calc_settings.reorder_lookback_days (выдачи +
    # списания, тот же набор событий, что и "движение" в отчётах) и
    # средний срок поставки последнего использованного поставщика группы
    # (compute_supplier_stats — тот же расчёт, что и в "Истории цен и
    # сроков поставщика").
    calc_settings = db.get(CalcSettings, 1)
    lookback_days = calc_settings.reorder_lookback_days if calc_settings else 30
    safety_margin_days = calc_settings.reorder_safety_margin_days if calc_settings else 7
    lookback_cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    consumed_rows = (
        db.query(
            MaterialSku.material_id,
            MaterialSku.color_id,
            MaterialSku.thickness_id,
            func.sum(-MaterialEvent.quantity_delta_m * MaterialEvent.width_mm / 1000),
        )
        .join(MaterialSku, MaterialEvent.material_sku_id == MaterialSku.id)
        .filter(MaterialEvent.event_type.in_([EventType.VYDACHA_UCHASTKU, EventType.SPISANIE]))
        .filter(MaterialEvent.timestamp >= lookback_cutoff)
        .group_by(MaterialSku.material_id, MaterialSku.color_id, MaterialSku.thickness_id)
        .all()
    )
    consumed_by_group = {(m, c, t): round(float(v or 0), 3) for m, c, t, v in consumed_rows}

    closed_rows = (
        db.query(PurchaseRequest, Supplier.name)
        .join(Supplier, PurchaseRequest.supplier_id == Supplier.id)
        .filter(PurchaseRequest.status == "closed", PurchaseRequest.supplier_id.isnot(None))
        .all()
    )
    supplier_stats = compute_supplier_stats(
        [
            ClosedRequestRecord(
                supplier_id=req.supplier_id,
                supplier_name=name,
                price_per_m2=float(req.price_per_m2) if req.price_per_m2 is not None else None,
                created_at=req.created_at,
                closed_at=req.closed_at,
                promised_delivery_date=req.promised_delivery_date,
            )
            for req, name in closed_rows
        ]
    )
    avg_lead_time_by_supplier = {s.supplier_id: s.avg_lead_time_days for s in supplier_stats}

    group_norms = normatives.film_group_norms(db)
    all_groups = set(stock_by_group) | set(reserved_by_group) | set(open_requested_by_group) | set(group_norms)
    result: list[StockOverviewLine] = []
    for material_id, color_id, thickness_id in all_groups:
        g = (material_id, color_id, thickness_id)
        norms = group_norms.get(g, normatives.Norms())
        _, shortage, to_order = normatives.suggest(
            demand=reserved_by_group.get(g, 0.0),
            have=stock_by_group.get(g, 0.0) + open_requested_by_group.get(g, 0.0),
            norms=norms,
        )
        supplier_id = usual_supplier_id_by_group.get((material_id, color_id, thickness_id))
        reorder = compute_reorder_signal(
            ReorderInput(
                current_stock_m2=stock_by_group.get((material_id, color_id, thickness_id), 0.0),
                consumed_m2_in_window=consumed_by_group.get((material_id, color_id, thickness_id), 0.0),
                lookback_days=lookback_days,
                avg_lead_time_days=avg_lead_time_by_supplier.get(supplier_id) if supplier_id else None,
                safety_margin_days=safety_margin_days,
            )
        )
        result.append(
            StockOverviewLine(
                material=db.get(Material, material_id).name,
                color=db.get(Color, color_id).name,
                thickness=float(db.get(Thickness, thickness_id).value_mm),
                total_area_m2=stock_by_group.get((material_id, color_id, thickness_id), 0.0),
                reserved_area_m2=reserved_by_group.get((material_id, color_id, thickness_id), 0.0),
                panel_demand_m2=panel_by_group.get((material_id, color_id, thickness_id), 0.0),
                open_requested_area_m2=open_requested_by_group.get((material_id, color_id, thickness_id), 0.0),
                usual_supplier=db.get(Supplier, supplier_id).name if supplier_id else None,
                days_of_stock_remaining=reorder.days_of_stock_remaining,
                reorder_suggested=reorder.reorder_suggested,
                min_stock_m2=norms.min_stock, min_batch_m2=norms.min_batch, batch_multiple_m2=norms.batch_multiple,
                shortage_m2=shortage, to_order_m2=to_order,
            )
        )
    result.sort(key=lambda r: (r.material, r.color, r.thickness))
    return result


class PanelFilmOut(BaseModel):
    part_id: int
    part_name: str
    need_pieces: float
    laminated: float
    to_laminate: float
    film_width_mm: float
    film_width_from_part: bool
    width_rule: str
    length_m: float
    area_m2: float
    film: str | None


view_panel_film = require_permission(
    "purchasing.manage", "production_tasks.manage", "production_tasks.view", "part_units.manage", "part_units.view"
)


@router.get("/panel-film", response_model=list[PanelFilmOut])
def panel_film(db: Session = Depends(get_db), user: User = Depends(view_panel_film)) -> list[PanelFilmOut]:
    """Плёнка под ламинацию панелей заказанных дверей: по каждой панели —
    сколько нужно, уже ламинировано, осталось и сколько плёнки; без
    закреплённой плёнки — отдельно (в резерв не идёт)."""
    return [
        PanelFilmOut(**{k: v for k, v in r.__dict__.items() if k != "group"})
        for r in panel_film_demand(db)
        if r.to_laminate > 0
    ]


@router.post("/stock-for-skus", response_model=list[StockForSkuOut])
def stock_for_skus(
    payload: StockForSkusRequest, db: Session = Depends(get_db), user: User = Depends(view_stock_for_sales)
) -> list[StockForSkuOut]:
    """Остаток/резерв/доступно для конкретных позиций номенклатуры —
    раздел про калькулятор заказа: продажник собирает заказ из нескольких
    дверей разных цветов, для каждого использованного цвета показываем,
    хватит ли текущего остатка с учётом того, что уже зарезервировано под
    текущие задания цеха. Дедуплицируем по группе материал+цвет+толщина —
    остаток считается на неё, не на конкретный sku_id (разные производители
    той же группы делят один пул стока, см. current_stock_m2)."""
    skus = db.query(MaterialSku).filter(MaterialSku.id.in_(payload.sku_ids)).all()
    if len(skus) != len(set(payload.sku_ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Одна или несколько позиций номенклатуры не найдены")
    stock_by_group, reserved_by_group = _stock_and_reserve_by_group(db)
    result: list[StockForSkuOut] = []
    for sku in skus:
        group = (sku.material_id, sku.color_id, sku.thickness_id)
        total = stock_by_group.get(group, 0.0)
        reserved = reserved_by_group.get(group, 0.0)
        result.append(
            StockForSkuOut(
                sku_id=sku.id,
                material=db.get(Material, sku.material_id).name,
                color=db.get(Color, sku.color_id).name,
                thickness=float(db.get(Thickness, sku.thickness_id).value_mm),
                total_area_m2=total,
                reserved_area_m2=reserved,
                available_area_m2=round(total - reserved, 3),
            )
        )
    return result


@router.get("", response_model=list[PurchaseRequestOut])
def list_purchase_requests(
    status_filter: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("purchasing.manage", "units.receive")),
) -> list[PurchaseRequestOut]:
    """История закупок (5.5 ТЗ) — открытые и закрытые заявки снабженцу.
    Читать список (не менять/закрывать — остальные эндпоинты этого файла
    по-прежнему только purchasing.manage) может и склад: при приёмке нужно
    видеть открытые заявки, чтобы привязать поставку к нужной (раздел про
    выдачу мимо хаба, обратная связь после переписи ролей — начальник
    склада сам ведёт приёмку)."""
    query = db.query(PurchaseRequest)
    if status_filter is not None:
        query = query.filter(PurchaseRequest.status == status_filter)
    requests = query.order_by(PurchaseRequest.created_at.desc()).limit(200).all()
    return [_out(db, r) for r in requests]


@router.post("", response_model=PurchaseRequestOut, status_code=status.HTTP_201_CREATED)
def create_purchase_request(
    payload: PurchaseRequestCreate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Заявка поставщику по сигналу нехватки (6.1 ТЗ) — материал/цвет/
    толщина вводятся текстом, как везде, и резолвятся в справочники."""
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    supplier = find_or_create_supplier(db, payload.supplier) if payload.supplier else None
    req = PurchaseRequest(
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        requested_area_m2=payload.requested_area_m2,
        note=payload.note,
        origin="planner",
        created_by=user.id,
        supplier_id=supplier.id if supplier else None,
        price_per_m2=payload.price_per_m2,
        promised_delivery_date=payload.promised_delivery_date,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


# Корзина заказа плёнки (22.10): в «Остатках» плёнку заказывают метрами —
# кладут позиции в корзину и одной заявкой отправляют закупщику; он сводит
# заявки в заказ поставщику на «Закупках». Метры × ширина рулона = м².
request_film = require_permission("purchasing.request", "purchasing.manage")


class RollWidthsOut(BaseModel):
    material: str
    color: str
    thickness: float
    widths: list[float]  # ширины рулонов этой плёнки, самая частая первой


@router.get("/roll-widths", response_model=list[RollWidthsOut])
def roll_widths(db: Session = Depends(get_db), user: User = Depends(request_film)) -> list[RollWidthsOut]:
    """Ширины рулонов (не штрипсов), какие приходили по каждой плёнке, — ширина по умолчанию в корзине."""
    rows = (
        db.query(Material.name, Color.name, Thickness.value_mm, MaterialUnit.width_mm, func.count(MaterialUnit.id))
        .join(MaterialSku, MaterialSku.id == MaterialUnit.material_sku_id)
        .join(Material, Material.id == MaterialSku.material_id)
        .join(Color, Color.id == MaterialSku.color_id)
        .join(Thickness, Thickness.id == MaterialSku.thickness_id)
        .filter(MaterialUnit.is_strip.is_(False))
        .group_by(Material.name, Color.name, Thickness.value_mm, MaterialUnit.width_mm)
        .all()
    )
    groups: dict[tuple, list[tuple[int, float]]] = {}
    for m, c, t, w, n in rows:
        groups.setdefault((m, c, float(t)), []).append((n, float(w)))
    return [
        RollWidthsOut(material=m, color=c, thickness=t, widths=[w for _, w in sorted(ws, key=lambda x: (-x[0], -x[1]))])
        for (m, c, t), ws in groups.items()
    ]


class CartLineIn(BaseModel):
    material: str
    color: str
    thickness: float
    length_m: float = Field(gt=0)
    width_mm: float = Field(gt=0)
    note: str | None = None


class CartIn(BaseModel):
    lines: list[CartLineIn] = Field(min_length=1)
    need_by: date | None = None
    note: str | None = Field(default=None, max_length=200)


@router.post("/cart", response_model=list[PurchaseRequestOut], status_code=status.HTTP_201_CREATED)
def send_cart(payload: CartIn, db: Session = Depends(get_db), user: User = Depends(request_film)) -> list[PurchaseRequestOut]:
    """Отправить корзину закупщику: по заявке на каждую позицию (одной транзакцией)."""
    created: list[PurchaseRequest] = []
    for ln in payload.lines:
        material, color, thickness = find_or_create_material_color_thickness(
            db, material=ln.material, color=ln.color, thickness=ln.thickness
        )
        note = "; ".join(x for x in (ln.note, payload.note) if x) or None
        req = PurchaseRequest(
            material_id=material.id,
            color_id=color.id,
            thickness_id=thickness.id,
            requested_length_m=round(ln.length_m, 2),
            width_mm=ln.width_mm,
            requested_area_m2=round(ln.length_m * ln.width_mm / 1000, 2),
            need_by=payload.need_by,
            note=note[:255] if note else None,
            origin="cart",
            created_by=user.id,
        )
        db.add(req)
        created.append(req)
    db.commit()
    for r in created:
        db.refresh(r)
    return [_out(db, r) for r in created]


@router.post("/shop-floor", response_model=PurchaseRequestOut, status_code=status.HTTP_201_CREATED)
def create_shop_floor_purchase_request(
    payload: PurchaseRequestShopFloorCreate,
    db: Session = Depends(get_db),
    user: User = Depends(create_shop_floor_request),
) -> PurchaseRequestOut:
    """Заявка "с цеха" — кнопка "Подать заявку на закупку" на "Выдаче
    участку", когда остатка на складе не хватает под строку задания. Тот
    же путь у кнопки "Заказать" в "Калькуляторе заказа" (продажник увидел
    нехватку при расчёте клиенту) — оба origin остаются "shop_floor", не
    заводим отдельный код ради того, кто именно нажал. Без supplier/
    price_per_m2 — их выбирает снабженец позже на "Закупках"."""
    material, color, thickness = find_or_create_material_color_thickness(
        db, material=payload.material, color=payload.color, thickness=payload.thickness
    )
    req = PurchaseRequest(
        material_id=material.id,
        color_id=color.id,
        thickness_id=thickness.id,
        requested_area_m2=payload.requested_area_m2,
        note=payload.note,
        origin="shop_floor",
        created_by=user.id,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/{request_id}/fulfill", response_model=PurchaseRequestOut)
def fulfill_purchase_request(
    request_id: int,
    payload: PurchaseRequestFulfillRequest,
    db: Session = Depends(get_db),
    user: User = Depends(fulfill_purchase_request_perm),
) -> PurchaseRequestOut:
    """Привязка заявки к конкретной приёмке по УПД (раздел про ускорение
    приёмки) — получатель на "Приёмке" выбрал открытую заявку, которую эта
    поставка закрывает. Отдельно от группового auto_close_on_receipt
    (services/purchasing.py) — тот остаётся как более грубый резерв для
    заявок, которые никто явно не привязал."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if req.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заявка уже закрыта")
    req.status = "closed"
    req.closed_at = datetime.now(timezone.utc)
    req.linked_upd_number = payload.upd_number
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.patch("/{request_id}", response_model=PurchaseRequestOut)
def update_purchase_request(
    request_id: int,
    payload: PurchaseRequestUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Цена/поставщик согласованы позже создания заявки (раздел про историю
    цен и сроков поставщика) — материал/цвет/толщина/объём неизменны."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if payload.supplier is not None:
        req.supplier_id = find_or_create_supplier(db, payload.supplier).id
    if payload.price_per_m2 is not None:
        if req.item_id is not None:
            req.price_per_unit = payload.price_per_m2  # у позиции — цена за её единицу
        else:
            req.price_per_m2 = payload.price_per_m2
    if payload.promised_delivery_date is not None:
        req.promised_delivery_date = payload.promised_delivery_date
    db.commit()
    db.refresh(req)
    return _out(db, req)


@router.post("/{request_id}/close", response_model=PurchaseRequestOut)
def close_purchase_request(
    request_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(manage_purchasing),
) -> PurchaseRequestOut:
    """Ручное закрытие — например, заказ отменён. Обычно заявка закрывается
    автоматически ближайшей приёмкой той же группы материала."""
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if req.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заявка уже закрыта")
    req.status = "closed"
    req.closed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(req)
    return _out(db, req)


def delete_purchase_request_impl(db: Session, req: PurchaseRequest) -> None:
    """Раздел про удаление сущностей — ничего не ссылается на
    purchase_requests.id кроме самого заказа поставщику (order_id), так
    что удаление всегда безопасно: если заявка была частью заказа, его
    агрегаты просто пересчитаются без неё при следующем открытии."""
    db.delete(req)


@router.delete("/{request_id}", response_model=DeleteResultOut)
def delete_purchase_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(manage_purchasing)
) -> DeleteResultOut:
    req = db.get(PurchaseRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка не найдена")
    if not user.is_superuser:
        o = _out(db, req)
        label = (
            f"Заявка №{req.id} — {o.item_name}, {o.quantity:g} {o.unit or ''}"
            if req.item_id is not None
            else f"Заявка №{req.id} — {o.material}, {o.color}, {o.thickness} мм, {o.requested_area_m2} м²"
        )
        request_deletion(db, entity_type="purchase_request", entity_id=req.id, entity_label=label, requested_by=user.id)
        db.commit()
        return DeleteResultOut(deleted=False, requested=True)
    delete_purchase_request_impl(db, req)
    db.commit()
    return DeleteResultOut(deleted=True, requested=False)



# ─── заявки на закупку любой позиции (14.10): материалы, комплектующие ───────


class ItemRequestIn(BaseModel):
    item_id: int
    quantity: float = Field(gt=0)
    need_by: date | None = None
    note: str | None = Field(default=None, max_length=255)
    supplier: str | None = None
    price_per_unit: float | None = Field(default=None, gt=0)
    promised_delivery_date: date | None = None


@router.post("/items", response_model=PurchaseRequestOut, status_code=status.HTTP_201_CREATED)
def create_item_request(payload: ItemRequestIn, db: Session = Depends(get_db), user: User = Depends(manage_purchasing)) -> PurchaseRequestOut:
    """Заявка на материал (МДФ, пенопласт, клей…) — так же, как на плёнку:
    в «Заявках поставщику», в заказе поставщику, с «нужно к»."""
    from app.models.items import Item

    item = db.get(Item, payload.item_id)
    if item is None or item.is_model:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Позиция не найдена")
    if db.query(MaterialSku.id).filter(MaterialSku.item_id == item.id).first():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Плёнка заказывается по материалу, цвету и толщине — обычной заявкой")
    supplier = find_or_create_supplier(db, payload.supplier) if payload.supplier else None
    req = PurchaseRequest(
        item_id=item.id, quantity=payload.quantity, need_by=payload.need_by, note=(payload.note or "").strip() or None,
        origin="planner", created_by=user.id, supplier_id=supplier.id if supplier else None,
        price_per_unit=payload.price_per_unit, promised_delivery_date=payload.promised_delivery_date,
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return _out(db, req)


class ItemReceiveIn(BaseModel):
    quantity: float = Field(gt=0)
    doc: str | None = Field(default=None, max_length=64)  # УПД / накладная
    price: float | None = Field(default=None, ge=0)
    close: bool = True  # пришло не всё — оставить заявку открытой
    occurred_at: date | None = None  # дата прихода задним числом


@router.post("/{request_id}/receive-item", response_model=PurchaseRequestOut)
def receive_item_request(
    request_id: int, payload: ItemReceiveIn, db: Session = Depends(get_db),
    user: User = Depends(require_permission("purchasing.manage", "units.receive", "materials.manage")),
) -> PurchaseRequestOut:
    """Поставка по заявке на материал: приход на склад (движение «приход» с
    документом и ценой) и закрытие заявки — одним действием."""
    from datetime import date as _date

    from app.models.items import Item
    from app.services import materials as mat

    req = db.get(PurchaseRequest, request_id)
    if req is None or req.item_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Заявка на позицию не найдена")
    if req.status == "closed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Заявка уже закрыта")
    item = db.get(Item, req.item_id)
    price = payload.price if payload.price is not None else (float(req.price_per_unit) if req.price_per_unit is not None else None)
    if price is not None:
        from app.models.prices import PRICE_UPD
        from app.services.prices import add_price

        try:
            add_price(db, item, price=price, currency=None, unit=None, source=PRICE_UPD, valid_from=payload.occurred_at or _date.today(), user_id=user.id,
                      doc=f"УПД {payload.doc}" if payload.doc else None)
            db.flush()
        except ValueError as e:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    try:
        from datetime import time as _time

        when = datetime.combine(payload.occurred_at, _time(12)) if payload.occurred_at else None
        mat.manual_move(db, item=item, kind="receipt", qty=payload.quantity, user_id=user.id, doc=payload.doc,
                        note=f"По заявке на закупку №{req.id}", occurred_at=when)
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    if payload.close:
        req.status = "closed"
        req.closed_at = datetime.now(timezone.utc)
        req.linked_upd_number = payload.doc
    db.commit()
    db.refresh(req)
    return _out(db, req)
