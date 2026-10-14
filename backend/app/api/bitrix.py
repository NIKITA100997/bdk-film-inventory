"""Настройки Битрикс24 (12.10): вебхук, чаты, кому задачи на закупку,
сотрудники программы ↔ пользователи Битрикса, журнал сообщений."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security import require_permission
from app.db.session import get_db
from app.models.integrations import BitrixOutbox
from app.models.users import User
from app.services import bitrix as bx

router = APIRouter(prefix="/bitrix", tags=["bitrix"])
admin = require_permission("users.manage")


class BitrixSettingsIO(BaseModel):
    enabled: bool = False
    webhook: str | None = None  # на чтение — маска; пусто при сохранении — не менять
    webhook_set: bool = False
    base_url: str | None = None
    chat_production: str | None = None
    chat_logistics: str | None = None
    chat_purchasing: str | None = None
    purchaser: int | None = None
    # сделки (14.10): воронка, создавать ли, стадии по ходу заказа, поле даты отгрузки
    deals_enabled: bool = False
    deal_category: int | None = None
    deal_auto_create: bool = True
    deal_stage_accepted: str | None = None
    deal_stage_production: str | None = None
    deal_stage_ready: str | None = None
    deal_stage_shipping: str | None = None
    deal_ship_field: str | None = None


def _mask(url: str) -> str:
    if not url:
        return ""
    parts = url.rstrip("/").split("/")
    return "/".join(parts[:-1] + ["•••" + parts[-1][-3:]]) if len(parts) > 3 else "•••"


@router.get("/settings", response_model=BitrixSettingsIO)
def get_bitrix_settings(db: Session = Depends(get_db), user: User = Depends(admin)) -> BitrixSettingsIO:
    s = bx.get_settings(db)
    return BitrixSettingsIO(**{k: v for k, v in s.items() if k in BitrixSettingsIO.model_fields and k != "webhook"},
                            webhook=_mask(s.get("webhook", "")), webhook_set=bool(s.get("webhook")))


@router.put("/settings", response_model=BitrixSettingsIO)
def put_bitrix_settings(payload: BitrixSettingsIO, db: Session = Depends(get_db), user: User = Depends(admin)) -> BitrixSettingsIO:
    s = bx.get_settings(db)
    new = payload.model_dump(exclude={"webhook", "webhook_set"})
    hook = (payload.webhook or "").strip()
    if hook and "•••" not in hook:
        if not hook.startswith("https://") or "/rest/" not in hook:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Адрес вебхука вида https://портал.bitrix24.ru/rest/1/код/")
        new["webhook"] = hook.rstrip("/") + "/"
    else:
        new["webhook"] = s.get("webhook", "")
    bx.save_settings(db, new, user.id)
    db.commit()
    return get_bitrix_settings(db, user)


class DealCategoryOut(BaseModel):
    id: int
    name: str
    stages: list[dict]  # [{id, name}]


class DealMetaOut(BaseModel):
    categories: list[DealCategoryOut]
    date_fields: list[dict]  # [{id, name}] — пользовательские поля-даты сделки


@router.get("/deal-meta", response_model=DealMetaOut)
def deal_meta(db: Session = Depends(get_db), user: User = Depends(admin)) -> DealMetaOut:
    """Воронки сделок со стадиями и поля-даты — для настройки сделок."""
    s = bx.get_settings(db)
    hook = s.get("webhook", "")
    try:
        cats = bx.call(hook, "crm.category.list", {"entityTypeId": 2}).get("result", {}).get("categories", [])
        out = []
        for c in cats:
            entity = "DEAL_STAGE" if int(c["id"]) == 0 else f"DEAL_STAGE_{c['id']}"
            st = bx.call(hook, "crm.status.list", {"filter": {"ENTITY_ID": entity}, "order": {"SORT": "ASC"}}).get("result", [])
            out.append(DealCategoryOut(id=int(c["id"]), name=c["name"], stages=[{"id": x["STATUS_ID"], "name": x["NAME"]} for x in st]))
        fields = bx.call(hook, "crm.deal.fields").get("result", {})
    except bx.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    dates = [{"id": k, "name": (v.get("formLabel") or v.get("listLabel") or k).strip()} for k, v in fields.items()
             if k.startswith("UF_") and v.get("type") in ("date", "datetime")]
    return DealMetaOut(categories=out, date_fields=dates)


@router.post("/deals/sync")
def deals_sync_now(db: Session = Depends(get_db), user: User = Depends(admin)) -> dict:
    """Сделки сейчас, не дожидаясь фона: найти/создать и передвинуть стадии."""
    from app.services.bitrix_deals import sync

    return sync(db)


class TestIn(BaseModel):
    dialog_id: str | None = None


@router.post("/test")
def test_bitrix(payload: TestIn, db: Session = Depends(get_db), user: User = Depends(admin)) -> dict:
    """Проверка: профиль вебхука и, если указан чат или пользователь, — сообщение туда."""
    s = bx.get_settings(db)
    try:
        prof = bx.call(s.get("webhook", ""), "profile").get("result", {})
        if payload.dialog_id:
            bx.call(s.get("webhook", ""), "im.message.add", {"DIALOG_ID": payload.dialog_id, "MESSAGE": "Проверка связи из «Учёта плёнки БДК»"})
    except bx.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return {"ok": True, "name": f"{prof.get('LAST_NAME', '')} {prof.get('NAME', '')}".strip()}


class ChatOut(BaseModel):
    dialog_id: str
    title: str


@router.get("/chats", response_model=list[ChatOut])
def list_chats(db: Session = Depends(get_db), user: User = Depends(admin)) -> list[ChatOut]:
    """Чаты, где состоит пользователь вебхука (последние)."""
    s = bx.get_settings(db)
    try:
        res = bx.call(s.get("webhook", ""), "im.recent.list", {"SKIP_OPENLINES": "Y", "SKIP_DIALOG": "Y", "LIMIT": 200}).get("result", {})
    except bx.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    items = res.get("items", []) if isinstance(res, dict) else res
    return [ChatOut(dialog_id=str(i.get("id")), title=i.get("title") or str(i.get("id"))) for i in items if i.get("type") == "chat"]


class BxUserOut(BaseModel):
    id: int
    name: str
    email: str | None = None


@router.get("/users", response_model=list[BxUserOut])
def list_bitrix_users(db: Session = Depends(get_db), user: User = Depends(admin)) -> list[BxUserOut]:
    s = bx.get_settings(db)
    out: list[BxUserOut] = []
    start = 0
    try:
        while True:
            data = bx.call(s.get("webhook", ""), "user.get", {"FILTER": {"ACTIVE": True}, "start": start})
            for u in data.get("result", []):
                name = " ".join(x for x in (u.get("LAST_NAME"), u.get("NAME"), u.get("SECOND_NAME")) if x)
                out.append(BxUserOut(id=int(u["ID"]), name=name or u.get("EMAIL") or u["ID"], email=u.get("EMAIL")))
            if "next" not in data or len(out) > 2000:
                break
            start = data["next"]
    except bx.BitrixError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e)) from e
    return sorted(out, key=lambda u: u.name.lower())


class UserMapRow(BaseModel):
    user_id: int
    full_name: str
    bitrix_user_id: int | None


@router.get("/user-map", response_model=list[UserMapRow])
def get_user_map(db: Session = Depends(get_db), user: User = Depends(admin)) -> list[UserMapRow]:
    return [
        UserMapRow(user_id=u.id, full_name=u.full_name or u.username, bitrix_user_id=u.bitrix_user_id)
        for u in db.query(User).filter(User.is_active.is_(True)).order_by(User.full_name)
    ]


class UserMapIn(BaseModel):
    user_id: int
    bitrix_user_id: int | None


@router.put("/user-map", response_model=list[UserMapRow])
def put_user_map(payload: list[UserMapIn], db: Session = Depends(get_db), user: User = Depends(admin)) -> list[UserMapRow]:
    for row in payload:
        u = db.get(User, row.user_id)
        if u is not None:
            u.bitrix_user_id = row.bitrix_user_id
    db.commit()
    return get_user_map(db, user)


class OutboxOut(BaseModel):
    id: int
    event: str
    status: str
    error: str | None
    text: str
    created_at: str


@router.get("/outbox", response_model=list[OutboxOut])
def list_outbox(db: Session = Depends(get_db), user: User = Depends(admin)) -> list[OutboxOut]:
    rows = db.query(BitrixOutbox).order_by(BitrixOutbox.id.desc()).limit(50).all()
    return [
        OutboxOut(
            id=r.id, event=r.event, status=r.status, error=r.error, created_at=r.created_at.isoformat(),
            text=str(r.params.get("MESSAGE") or (r.params.get("fields") or {}).get("TITLE") or "")[:300],
        )
        for r in rows
    ]


@router.post("/outbox/{outbox_id}/retry")
def retry_outbox(outbox_id: int, db: Session = Depends(get_db), user: User = Depends(admin)) -> dict:
    bx.retry(db, outbox_id)
    return {"ok": True}
