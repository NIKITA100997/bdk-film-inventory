from pydantic import BaseModel, ConfigDict

from app.models.users import Area, UserRole


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    role: UserRole
    area: Area | None
    is_active: bool


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
