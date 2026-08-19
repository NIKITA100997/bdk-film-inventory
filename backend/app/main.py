from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
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
# Под /api вместе с остальным бэкендом — frontend/src/api/dictionaries.ts
# строит URL фото как `${apiClient.defaults.baseURL}/uploads/...`, а
# baseURL теперь сам содержит /api (см. комментарий у API_PREFIX ниже).
app.mount("/api/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")

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

# Раздел про долгую загрузку на планшетах по Wi-Fi — собранный JS-бандл
# фронтенда почти 2 МБ и раньше отдавался несжатым (curl подтвердил:
# content-length == размеру файла на диске, без content-encoding) — на
# домашнем/цеховом Wi-Fi это заметно медленнее, чем на localhost, где то
# же самое качается за доли секунды. GZip сжимает такой бандл в разы.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Раздел про ускорение первой загрузки на планшетах — единый префикс
# /api на ВСЕХ роутерах без исключений. Обнаружено при проверке быстрого
# режима: без префикса пути фронтенда и бэкенда были в одном "плоском"
# пространстве имён на одном порту (frontend/src/routes.tsx "/production-
# tasks" ↔ backend GET /production-tasks и ещё 8 таких же совпадений:
# /areas, /calc-settings, /deletion-requests, /materials, /label-template,
# /product-models, /production-lines, /roles) — прямой переход браузера
# (обновление страницы, диплинк, QR) на такую страницу СНАЧАЛА попадал в
# реальный API-эндпоинт (он раньше в списке роутеров, чем SPA-заглушка) и
# 401-ил, а не открывал страницу: у обычной навигации браузера нет
# Authorization-заголовка, его добавляет только axios-клиент фронтенда.
# /api полностью разводит два пространства путей, а не чинит совпадения
# по одному — тот же риск иначе вернётся с любым новым именем раздела.
API_PREFIX = "/api"

app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(deletion_requests_router, prefix=API_PREFIX)
app.include_router(areas_router, prefix=API_PREFIX)
app.include_router(units_router, prefix=API_PREFIX)
app.include_router(labels_router, prefix=API_PREFIX)
app.include_router(storage_router, prefix=API_PREFIX)
app.include_router(dictionaries_router, prefix=API_PREFIX)
app.include_router(inventory_router, prefix=API_PREFIX)
app.include_router(material_cards_router, prefix=API_PREFIX)
app.include_router(production_router, prefix=API_PREFIX)
app.include_router(abc_router, prefix=API_PREFIX)
app.include_router(reports_router, prefix=API_PREFIX)
app.include_router(purchasing_router, prefix=API_PREFIX)
app.include_router(supplier_orders_router, prefix=API_PREFIX)
app.include_router(suppliers_router, prefix=API_PREFIX)
app.include_router(users_router, prefix=API_PREFIX)
app.include_router(roles_router, prefix=API_PREFIX)
app.include_router(write_off_reasons_router, prefix=API_PREFIX)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


def resolve_static_path(base: Path, requested: str) -> Path | None:
    """Путь до конкретного файла внутри base, если он реально там
    существует — иначе None (не найден, пустой запрос, либо requested
    пытается выйти за пределы base через "../", раздел про
    production-раздачу фронтенда). Чистая функция — тестируется без
    поднятия приложения/сервера."""
    if not requested:
        return None
    candidate = (base / requested).resolve()
    if candidate.is_file() and candidate.is_relative_to(base):
        return candidate
    return None


# Раздел про ускорение первой загрузки на планшетах — отдаём готовую
# production-сборку фронтенда (frontend/dist, npm run build), а не
# полагаемся на dev-сервер Vite, который на первой загрузке пересобирает и
# отдаёт сотни отдельных файлов по одному. Включается только если сборка
# реально существует на диске — на машине, где `npm run build` ни разу не
# запускали (обычная разработка через `npm run dev` на 5173), этот блок
# просто не регистрируется и ни на что не влияет. Регистрируется последним
# (после всех API-роутеров и /uploads), поэтому не перехватывает ни один
# существующий путь — только то, что не подошло больше никуда.
_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str) -> FileResponse:
        """Реальный файл сборки (JS/CSS/иконки) — если есть на диске,
        иначе index.html: так работает маршрутизация React Router (любой
        путь приложения — не только "/" — должен получить ту же
        SPA-страницу, а не 404)."""
        found = resolve_static_path(_FRONTEND_DIST, full_path)
        if found is not None and found.is_relative_to(_FRONTEND_DIST / "assets"):
            # Имена файлов в assets/ содержат хэш содержимого (Vite) — при
            # изменении кода имя меняется само, так что кэшировать "навечно"
            # безопасно: старый файл никогда не переиспользуется под новым
            # содержимым. Без этого заголовка планшет перекачивал бы
            # 2 МБ бандла заново при каждом заходе, а не только один раз.
            return FileResponse(found, headers={"Cache-Control": "public, max-age=31536000, immutable"})
        return FileResponse(found or _FRONTEND_DIST / "index.html")
