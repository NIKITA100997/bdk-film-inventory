from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

is_sqlite = settings.database_url.startswith("sqlite")
pool_kwargs = {} if is_sqlite else {"pool_size": 20, "max_overflow": 20, "pool_timeout": 30}
engine = create_engine(settings.database_url, pool_pre_ping=True, **pool_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
