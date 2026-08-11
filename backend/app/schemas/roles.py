from pydantic import BaseModel, ConfigDict


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    section: str


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str | None
    name: str
    is_active: bool
    permissions: list[PermissionOut]


class RoleCreate(BaseModel):
    name: str


class RoleUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


class RolePermissionsUpdate(BaseModel):
    permission_ids: list[int]
