from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.abc import router as abc_router
from app.api.areas import router as areas_router
from app.api.auth import router as auth_router
from app.api.deletion_requests import router as deletion_requests_router
from app.api.dictionaries import router as dictionaries_router
from app.api.inventory import router as inventory_router
from app.api.labels import router as labels_router
from app.api.material_cards import router as material_cards_router
from app.api.production import router as production_router
from app.api.purchasing import router as purchasing_router
from app.api.supplier_orders import router as supplier_orders_router
from app.api.reports import router as reports_router
from app.api.roles import router as roles_router
from app.api.storage import router as storage_router
from app.api.suppliers import router as suppliers_router
from app.api.units import router as units_router
from app.api.users import router as users_router
from app.api.write_off_reasons import router as write_off_reasons_router
from app.core.config import settings

app = FastAPI(title="БДК — учёт плёнки")

Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "https://localhost:5173", "https://127.0.0.1:5173"],
    # Плюс любой адрес в частных диапазонах (192.168.x.x/10.x.x.x/172.16-31.x.x)
    # на том же порту — открыть с планшета/телефона по IP компьютера в
    # локальной сети, без auth-cookie (токен в заголовке) риска в этом нет.
    # http и https оба разрешены — раздел про сканирование QR: планшетам
    # нужен HTTPS (самоподписанный сертификат) для доступа к камере, но
    # http остаётся рабочим для случаев без него.
    allow_origin_regex=r"https?://(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(deletion_requests_router)
app.include_router(areas_router)
app.include_router(units_router)
app.include_router(labels_router)
app.include_router(storage_router)
app.include_router(dictionaries_router)
app.include_router(inventory_router)
app.include_router(material_cards_router)
app.include_router(production_router)
app.include_router(abc_router)
app.include_router(reports_router)
app.include_router(purchasing_router)
app.include_router(supplier_orders_router)
app.include_router(suppliers_router)
app.include_router(users_router)
app.include_router(roles_router)
app.include_router(write_off_reasons_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
