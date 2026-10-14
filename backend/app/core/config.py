from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str = "postgresql+psycopg://bdk_app:bdk_app@localhost:5432/bdk_film"
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12
    # Фото плёнки (8 раздел обратной связи) — на диске сервера, не во
    # внешнем хранилище; отдаётся статикой из main.py по /uploads.
    upload_dir: str = "uploads"
    # Описание API (/docs, /openapi.json) — по умолчанию выключено (14.10,
    # проверка качества: открыто без входа показывало все адреса API).
    # На dev включается API_DOCS=true в .env.
    api_docs: bool = False


settings = Settings()
