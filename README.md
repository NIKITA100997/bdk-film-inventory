# БДК — учёт плёнки

ТЗ: [`БДК_Проект_учета_пленок.md`](./БДК_Проект_учета_пленок.md). План разработки и статус этапов — там же в разделе 8 (roadmap).

## Backend (FastAPI + PostgreSQL)

```powershell
cd backend
.venv\Scripts\Activate.ps1
# скопировать .env.example -> .env и при необходимости поправить DATABASE_URL/JWT_SECRET
alembic upgrade head
python -m app.seed          # создаёт пользователя admin/admin
uvicorn app.main:app --reload
```

Swagger: http://localhost:8000/docs

Тесты: `pytest` (из папки `backend`, venv активирован).

## Frontend (React + Vite + Ant Design)

```powershell
cd frontend
npm install
npm run dev
```

Приложение: http://localhost:5173 — ожидает backend на http://localhost:8000 (см. `VITE_API_URL` в `.env`, по умолчанию не требуется).

## Быстрый режим для планшетов (production-сборка)

`start.bat` запускает dev-сервер Vite (5173) — удобно при правках кода, но
первая загрузка страницы на планшете по Wi-Fi заметно медленнее (сервер
пересобирает и отдаёт сотни отдельных файлов). `start_fast.bat` вместо
этого один раз собирает фронтенд (`npm run build`) и запускает backend без
`--reload` — он сам отдаёт готовый сайт на том же порту 8002 (5173 не
нужен). Планшеты открывают `https://<IP-компьютера>:8002`.

Правки кода в собранную версию сами не попадают — после изменений нужно
заново запустить `start_fast.bat`, чтобы пересобрать. Во время активной
разработки удобнее `start.bat`.

## Роли пользователей

`nachalnik_tsekha`, `nachalnik_uchastka` (+ `area`: `okutka_tsargovykh` / `shchitovye_dveri` / `tselnolistovye_dveri`), `operator_sklada`, `kladovshchik`, `snabzhenets`, `logist`, `admin` — подробности в разделе 6 ТЗ.
