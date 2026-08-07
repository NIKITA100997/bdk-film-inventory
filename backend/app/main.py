from fastapi import FastAPI

from app.api.auth import router as auth_router
from app.api.labels import router as labels_router
from app.api.storage import router as storage_router
from app.api.units import router as units_router

app = FastAPI(title="БДК — учёт плёнки")

app.include_router(auth_router)
app.include_router(units_router)
app.include_router(labels_router)
app.include_router(storage_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
