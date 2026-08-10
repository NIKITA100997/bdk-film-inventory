"""Правило участка при создании/правке пользователя (3 раздел бэклога
доработок) — участок имеет смысл только для роли «начальник участка»,
для остальных ролей всегда сбрасывается."""

from app.models.users import Area, UserRole


def resolve_area(role: UserRole, requested_area: Area | None, existing_area: Area | None = None) -> Area | None:
    if role != UserRole.NACHALNIK_UCHASTKA:
        return None
    return requested_area if requested_area is not None else existing_area


def area_is_missing(role: UserRole, resolved_area: Area | None) -> bool:
    return role == UserRole.NACHALNIK_UCHASTKA and resolved_area is None
