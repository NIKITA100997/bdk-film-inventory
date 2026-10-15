"""Права по адресам API (14.10, по итогам проверки качества) — без базы:
по коду маршрутов видно, какое право требует каждый адрес. Тест падает,
если важный адрес поменял права, или появился изменяющий адрес без
проверки права. Новая операция с правами — дописать сюда осознанно."""

from types import SimpleNamespace

import pytest
from fastapi.routing import APIRoute

import app.models  # noqa: F401
from app.core.security import get_current_user, sees_all_areas
from app.main import app


def _walk(routes, prefix=""):
    for r in routes:
        if type(r).__name__ == "_IncludedRouter":
            yield from _walk(r.original_router.routes, prefix + (r.include_context.prefix or ""))
        elif isinstance(r, APIRoute):
            yield prefix + r.path, r


def _guard(dependant):
    codes, login = set(), False
    stack = [dependant]
    while stack:
        d = stack.pop()
        c = getattr(d.call, "permission_codes", None)
        if c is not None:
            codes |= set(c)
        if d.call is get_current_user:
            login = True
        stack.extend(d.dependencies)
    return codes, login


ROUTES = {f"{m} {p}": _guard(r.dependant) for p, r in _walk(app.routes) for m in r.methods}

# Утверждённые права важных адресов: «склад — закупки — производство — продажи».
POLICY = {
    "POST /api/area-supply/requests": {"production_tasks.report", "production_tasks.manage", "units.issue"},
    "POST /api/area-supply/requests/{req_id}/done": {"units.issue", "production_tasks.manage"},
    "PUT /api/area-supply/norms": {"production_tasks.manage"},
    "PUT /api/film-reserve/settings": {"users.manage"},
    "POST /api/film-reserve/customer-orders/{co_id}": {"production_tasks.manage"},
    "DELETE /api/film-reserve/customer-orders/{co_id}": {"production_tasks.manage"},
    "POST /api/film-reserve/{res_id}/release": {"film_reserve.override"},
    "GET /api/purchase-requests": {"purchasing.manage", "units.receive"},
    "POST /api/purchase-requests/items": {"purchasing.manage"},
    "POST /api/purchase-requests/{request_id}/receive-item": {"materials.manage", "purchasing.manage", "units.receive"},
    "GET /api/supplier-orders": {"purchasing.manage"},
    "POST /api/supplier-orders": {"purchasing.manage"},
    "GET /api/prices": {"prices.manage", "prices.view"},
    "GET /api/reports/area-costs": {"prices.manage", "prices.view"},
    "GET /api/users": {"users.manage"},
    "POST /api/users": {"users.manage"},
    "GET /api/roles": {"users.manage"},
    "GET /api/bitrix/settings": {"users.manage"},
    "PUT /api/bitrix/settings": {"users.manage"},
    "POST /api/customer-orders/{order_id}/accept": {"production_tasks.manage"},
    "POST /api/customer-orders/{order_id}/return": {"production_tasks.manage"},
    "POST /api/customer-orders": {"orders.request", "production_tasks.manage"},
    "POST /api/customer-orders/{order_id}/promise": {"orders.request", "production_tasks.manage"},
    "POST /api/production-tasks/{task_id}/lines/{line_id}/reports": {"production_tasks.manage", "production_tasks.report"},
    "POST /api/production-tasks/{task_id}/lines/{line_id}/reports/batch": {"production_tasks.manage", "production_tasks.report"},
    "POST /api/production-tasks/operations": {"production_tasks.manage"},
    "DELETE /api/production-tasks/{task_id}": {"production_tasks.manage"},
    "POST /api/material-stock/moves": {"materials.manage", "part_units.manage", "production_tasks.manage", "units.receive"},
    "POST /api/part-units": {"part_units.manage"},
    "POST /api/part-units/{unit_id}/issue": {"part_units.manage"},
    "POST /api/units/receive": {"units.receive"},
    "POST /api/units/{unit_id}/issue": {"units.issue"},
    "POST /api/needs/purchase": {"production_tasks.manage", "purchasing.manage"},
    "POST /api/weekly-plan/{week}/approve": {"plan.approve"},
}

# Без входа — только это.
OPEN = {"POST /api/auth/login", "POST /api/auth/forgot-password", "GET /health", "GET /{full_path:path}"}

# Изменяющие адреса «только вход» — право проверяется внутри или менять нечего.
LOGIN_ONLY_MUTATIONS = {
    "POST /api/auth/change-password",  # свой пароль
    "POST /api/action-requests",  # просьба администратору
    "POST /api/units/cutting-operations/{operation_id}/undo",  # has_undo_permission внутри
    "POST /api/units/bulk-edit",  # право на каждое поле внутри
    "POST /api/units/cutting-plan",  # расчёт, без записи
    "POST /api/units/cutting-recipe",  # расчёт, без записи
    "PATCH /api/storage-places/{kind}/{place_id}",  # _get_place проверяет право
    "DELETE /api/storage-places/{kind}/{place_id}",  # _get_place проверяет право
    # печать этикеток — без записи
    "POST /api/labels/batch", "POST /api/labels/batch/html",
    "POST /api/racks/{rack_id}/rack-label", "POST /api/racks/{rack_id}/rack-label/html",
    "POST /api/racks/{rack_id}/shelf-labels/batch", "POST /api/racks/{rack_id}/shelf-labels/batch/html",
    "POST /api/part-labels/batch", "POST /api/part-labels/batch/html",
    "POST /api/part-racks/{rack_id}/rack-label", "POST /api/part-racks/{rack_id}/rack-label/html",
    "POST /api/part-racks/{rack_id}/shelf-labels/batch", "POST /api/part-racks/{rack_id}/shelf-labels/batch/html",
}


@pytest.mark.parametrize("route", sorted(POLICY))
def test_important_routes_keep_their_permissions(route):
    assert route in ROUTES, f"адрес {route} пропал — обновите таблицу"
    codes, _ = ROUTES[route]
    assert codes == POLICY[route], f"{route}: права {sorted(codes)}, ожидалось {sorted(POLICY[route])}"


def test_only_known_routes_are_open():
    open_ = {k for k, (codes, login) in ROUTES.items() if not codes and not login}
    assert open_ <= OPEN, f"открыто без входа: {sorted(open_ - OPEN)}"


def test_every_mutation_checks_permission():
    unguarded = {
        k for k, (codes, login) in ROUTES.items()
        if not k.startswith(("GET ", "HEAD ")) and not codes and k not in OPEN
    }
    assert unguarded <= LOGIN_ONLY_MUTATIONS, f"изменяющие адреса без права: {sorted(unguarded - LOGIN_ONLY_MUTATIONS)}"


def _user(perms, area=None, su=False):
    return SimpleNamespace(is_superuser=su, area=area, roles=[SimpleNamespace(is_active=True, permissions=[SimpleNamespace(code=c) for c in perms])])


def test_area_visibility():
    # мастер с участком и управлением заданиями — только свой участок
    assert not sees_all_areas(_user({"production_tasks.manage", "production_tasks.report"}, area="okutka_tsargovykh"))
    # с правом «Задания всех участков» — все
    assert sees_all_areas(_user({"production_tasks.manage", "production_tasks.all_areas"}, area="fabrika"))
    # без участка в профиле — как раньше: управление или выдача плёнки
    assert sees_all_areas(_user({"production_tasks.manage"}))
    assert sees_all_areas(_user({"units.issue"}))
    assert not sees_all_areas(_user({"production_tasks.report"}))
    assert sees_all_areas(_user(set(), area="fabrika", su=True))


def test_prices_hidden_without_permission():
    from app.core import price_visibility as pv
    from app.schemas.units import MaterialUnitOut

    fields = {n: None for n in MaterialUnitOut.model_fields}
    assert "price_per_m2" in fields
    token = pv._sees.set(False)
    try:
        assert pv.hide(123.45) is None
    finally:
        pv._sees.reset(token)
    assert pv.hide(123.45) == 123.45
