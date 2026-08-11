"""Правило участка при создании/правке пользователя (3 раздел бэклога
доработок) — участок имеет смысл только если среди назначенных ролей есть
«начальник участка», для остальных случаев всегда сбрасывается.

С переходом на гибкую ролевую модель (8.3 раздел бэклога доработок) роль —
не одно значение, а список назначенных `Role`; проверяем по `code`
(системный, неизменяемый идентификатор), а не по `name` (её администратор
может переименовать) — см. app/models/roles.py."""

from collections.abc import Collection

from app.models.users import Area, UserRole


def resolve_area(role_codes: Collection[str], requested_area: Area | None, existing_area: Area | None = None) -> Area | None:
    if UserRole.NACHALNIK_UCHASTKA.value not in role_codes:
        return None
    return requested_area if requested_area is not None else existing_area


def area_is_missing(role_codes: Collection[str], resolved_area: Area | None) -> bool:
    return UserRole.NACHALNIK_UCHASTKA.value in role_codes and resolved_area is None
