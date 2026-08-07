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

## Роли пользователей

`nachalnik_tsekha`, `nachalnik_uchastka` (+ `area`: `okutka_tsargovykh` / `shchitovye_dveri` / `tselnolistovye_dveri`), `operator_sklada`, `kladovshchik`, `snabzhenets`, `logist`, `admin` — подробности в разделе 6 ТЗ.
