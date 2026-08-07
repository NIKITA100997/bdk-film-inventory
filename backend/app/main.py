from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.dictionaries import router as dictionaries_router
from app.api.labels import router as labels_router
from app.api.storage import router as storage_router
from app.api.units import router as units_router

app = FastAPI(title="БДК — учёт плёнки")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(units_router)
app.include_router(labels_router)
app.include_router(storage_router)
app.include_router(dictionaries_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
