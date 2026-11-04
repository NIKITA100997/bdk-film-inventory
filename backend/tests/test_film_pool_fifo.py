import pytest
from datetime import date
from app.db.session import SessionLocal
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.production import (
    ProductionLine,
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
    ProductionTaskLineReport,
)
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.services.film_pool import adjust_strip_pool_stock, consume_film_strips_fifo, get_area_strip_stock


@pytest.fixture
def setup_pogonazh_data():
    db = SessionLocal()
    try:
        mat = db.query(Material).filter(Material.name == "ПВХ Погонаж Тест").first()
        if not mat:
            mat = Material(name="ПВХ Погонаж Тест", is_active=True)
            db.add(mat)
            db.flush()

        col = db.query(Color).filter(Color.name == "Белый Погонаж Тест").first()
        if not col:
            col = Color(name="Белый Погонаж Тест", is_active=True)
            db.add(col)
            db.flush()

        th = db.query(Thickness).first()
        if not th:
            th = Thickness(value_mm=0.18, is_active=True)
            db.add(th)
            db.flush()

        mfr = db.query(Manufacturer).first()
        if not mfr:
            mfr = Manufacturer(name="Завод Погонаж Тест", is_active=True)
            db.add(mfr)
            db.flush()

        sku = (
            db.query(MaterialSku)
            .filter(
                MaterialSku.material_id == mat.id,
                MaterialSku.color_id == col.id,
                MaterialSku.thickness_id == th.id,
                MaterialSku.manufacturer_id == mfr.id,
            )
            .first()
        )
        if not sku:
            sku = MaterialSku(
                material_id=mat.id,
                color_id=col.id,
                thickness_id=th.id,
                manufacturer_id=mfr.id,
            )
            db.add(sku)
            db.flush()

        user = db.query(User).first()
        if not user:
            user = User(
                username="master_pogonazh",
                full_name="Мастер Погонажа",
                role_id="master",
                is_active=True,
            )
            db.add(user)
            db.flush()

        task = ProductionTask(
            name="Задание Добор Тест 100",
            area="fabrika",
            quantity=100,
            created_by=user.id,
            is_active=True,
        )
        db.add(task)
        db.flush()

        line = ProductionTaskLine(
            task_id=task.id,
            material_id=mat.id,
            color_id=col.id,
            thickness_id=th.id,
            quantity_pieces=100,
            width_mm=100.0,
            length_m=2.0,  # 2 метра на одну штуку
            strip_width_mm=221.0,  # точная ширина штрипса 221 мм
            part_name="Добор 100",
        )
        db.add(line)
        db.flush()

        # Списываем старые активные штрипсы на участке, чтобы тесты не влияли друг на друга
        db.query(MaterialUnit).filter(
            MaterialUnit.area == "fabrika",
            MaterialUnit.status == UnitStatus.VYDAN_UCHASTKU,
        ).update({MaterialUnit.status: UnitStatus.SPISAN}, synchronize_session=False)
        db.flush()

        yield {
            "db": db,
            "material": mat,
            "color": col,
            "thickness": th,
            "sku": sku,
            "user": user,
            "task": task,
            "line": line,
        }
    finally:
        db.rollback()
        db.close()


def test_film_strip_multi_rollover_fifo(setup_pogonazh_data):
    """Штрипс #1 (50м) + Штрипс #2 (100м). Нужно 120м (60 шт х 2м).
    Штрипс #1 должен списаться в 0 (SPISAN, 25 шт),
    Штрипс #2 должен покрыть остаток 70м (35 шт) и остаться с 30м."""
    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]
    user = d["user"]

    strip1 = MaterialUnit(
        upd_number="UPD-POG-1",
        pallet_number="PAL-1",
        material_sku_id=sku.id,
        width_mm=221.0,
        length_m=50.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    strip2 = MaterialUnit(
        upd_number="UPD-POG-2",
        pallet_number="PAL-2",
        material_sku_id=sku.id,
        width_mm=221.0,
        length_m=100.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    db_session = db
    db_session.add_all([strip1, strip2])
    db_session.flush()

    stock_m, count = get_area_strip_stock(db_session, "fabrika", line)
    assert stock_m == 150.0
    assert count == 2

    allocs = consume_film_strips_fifo(
        db_session,
        line=line,
        area="fabrika",
        good_pieces=60,
        defect_pieces=0,
        user_id=user.id,
    )

    assert len(allocs) == 2
    assert allocs[0].material_unit_id == strip1.id
    assert allocs[0].good_pieces == 25.0
    assert allocs[0].meters == 50.0
    assert not allocs[0].is_deficit

    assert allocs[1].material_unit_id == strip2.id
    assert allocs[1].good_pieces == 35.0
    assert allocs[1].meters == 70.0
    assert not allocs[1].is_deficit

    assert strip1.status == UnitStatus.SPISAN
    assert strip2.status == UnitStatus.VYDAN_UCHASTKU


def test_film_strip_deficit_insufficient_stock(setup_pogonazh_data):
    """Штрипс #1 (30м). Нужно 50м (25 шт х 2м).
    30м списываются со штрипса #1 (15 шт, SPISAN),
    а 20м (10 шт) фиксируются как дефицит без 422 ошибки."""
    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]
    user = d["user"]

    strip1 = MaterialUnit(
        upd_number="UPD-POG-DEF-1",
        pallet_number="PAL-1",
        material_sku_id=sku.id,
        width_mm=221.0,
        length_m=30.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    db_session = db
    db_session.add(strip1)
    db_session.flush()

    allocs = consume_film_strips_fifo(
        db_session,
        line=line,
        area="fabrika",
        good_pieces=25,
        defect_pieces=0,
        user_id=user.id,
    )

    assert len(allocs) == 2
    assert allocs[0].material_unit_id == strip1.id
    assert allocs[0].good_pieces == 15.0
    assert allocs[0].meters == 30.0
    assert not allocs[0].is_deficit
    assert strip1.status == UnitStatus.SPISAN

    assert allocs[1].material_unit_id is None
    assert allocs[1].good_pieces == 10.0
    assert allocs[1].meters == 20.0
    assert allocs[1].is_deficit


def test_film_strip_zero_stock_deficit(setup_pogonazh_data):
    """На участке 0 штрипсов. Списание 10 шт (20м) проходит как дефицит."""
    d = setup_pogonazh_data
    db = d["db"]
    line = d["line"]
    user = d["user"]

    allocs = consume_film_strips_fifo(
        db,
        line=line,
        area="fabrika",
        good_pieces=10,
        defect_pieces=0,
        user_id=user.id,
    )

    assert len(allocs) == 1
    assert allocs[0].material_unit_id is None
    assert allocs[0].good_pieces == 10.0
    assert allocs[0].meters == 20.0
    assert allocs[0].is_deficit


def test_film_strip_exact_width_matching(setup_pogonazh_data):
    """Штрипс 300мм на участке не должен списываться под строку с шириной 221мм."""
    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]
    user = d["user"]

    strip_wrong_width = MaterialUnit(
        upd_number="UPD-POG-300",
        pallet_number="PAL-300",
        material_sku_id=sku.id,
        width_mm=300.0,
        length_m=100.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    db.add(strip_wrong_width)
    db.flush()

    allocs = consume_film_strips_fifo(
        db,
        line=line,
        area="fabrika",
        good_pieces=10,
        defect_pieces=0,
        user_id=user.id,
    )

    assert len(allocs) == 1
    assert allocs[0].is_deficit
    assert strip_wrong_width.status == UnitStatus.VYDAN_UCHASTKU


def test_report_endpoint_fifo_integration(setup_pogonazh_data):
    """Проверка полного сквозного отчёта через _build_task_line_report."""
    from app.api.production import _build_task_line_report, _line_deficit_aggregates
    from app.schemas.production import ProductionTaskLineReportCreate

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]
    task = d["task"]
    user = d["user"]

    pline = db.query(ProductionLine).filter(ProductionLine.area == "fabrika").first()
    if not pline:
        pline = ProductionLine(area="fabrika", name="Линия Тест Фабрика", is_active=True)
        db.add(pline)
        db.flush()

    # Добавляем распределение по дням для строки задания
    assignment = ProductionTaskLineAssignment(
        task_line_id=line.id,
        line_id=pline.id,
        date=date.today(),
        quantity_pieces=100,
        employee_names="Оператор Тест",
        created_by=user.id,
    )
    db.add(assignment)
    db.flush()

    strip = MaterialUnit(
        upd_number="UPD-INT-1",
        pallet_number="PAL-INT-1",
        material_sku_id=sku.id,
        width_mm=221.0,
        length_m=30.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    db.add(strip)
    db.flush()

    # Мастер шлёт отчёт на 20 шт (40м плёнки), material_unit_id=None
    payload = ProductionTaskLineReportCreate(
        assignment_id=assignment.id,
        material_unit_id=None,
        good_pieces=20.0,
        defect_pieces=0.0,
        counts_toward_line=True,
    )
    reports = _build_task_line_report(task.id, line.id, payload, db, user)

    # 15 шт (30м) со штрипса + 5 шт (10м) дефицита
    assert len(reports) == 2
    assert reports[0].material_unit_id == strip.id
    assert reports[0].good_pieces == 15.0

    assert reports[1].material_unit_id is None
    assert reports[1].good_pieces == 5.0
    assert "Дефицит плёнки: 10.0 м" in (reports[1].note or "")

    # Проверяем агрегат дефицита
    deficits = _line_deficit_aggregates(db, [line.id])
    assert deficits.get(line.id) == 5.0

def test_film_strip_analog_width_matching(setup_pogonazh_data):
    """Проверка списания штрипса из пула по группе аналогов ширины (220мм вместо 221мм)."""
    from app.models.width_analogs import WidthAnalogGroup, WidthAnalogMember

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]  # strip_width_mm = 221.0
    user = d["user"]

    # Удаляем старые тестовые группы с этими ширинами, если были
    existing_members = db.query(WidthAnalogMember).filter(WidthAnalogMember.width_mm.in_([220.0, 221.0])).all()
    for m in existing_members:
        db.delete(m)
    db.flush()

    grp = WidthAnalogGroup(note="Тест 220-221")
    db.add(grp)
    db.flush()
    db.add(WidthAnalogMember(group_id=grp.id, width_mm=220.0))
    db.add(WidthAnalogMember(group_id=grp.id, width_mm=221.0))
    db.flush()

    # Очищаем кэш эквивалентных ширин в db.info, если есть
    if "read_cache" in db.info and "equiv_widths" in db.info["read_cache"]:
        db.info["read_cache"]["equiv_widths"].clear()

    from app.models.dictionaries import Color
    col_analog = Color(name="Уникальный Цвет Аналог", is_active=True)
    db.add(col_analog)
    db.flush()
    sku_analog = MaterialSku(material_id=d["material"].id, color_id=col_analog.id, thickness_id=d["thickness"].id, manufacturer_id=sku.manufacturer_id)
    db.add(sku_analog)
    db.flush()
    line.color_id = col_analog.id

    strip_analog = MaterialUnit(
        upd_number="UPD-ANALOG-1",
        pallet_number="PAL-ANALOG-1",
        material_sku_id=sku_analog.id,
        width_mm=220.0,
        length_m=50.0,
        status=UnitStatus.VYDAN_UCHASTKU,
        area="fabrika",
        is_strip=True,
    )
    db.add(strip_analog)
    db.flush()

    allocations = consume_film_strips_fifo(
        db,
        line=line,
        area="fabrika",
        good_pieces=10.0,
        defect_pieces=0.0,
        user_id=user.id,
    )

    from app.services.film_pool import get_area_matching_strips
    candidates = get_area_matching_strips(
        db,
        area="fabrika",
        material_id=line.material_id,
        color_id=line.color_id,
        thickness_id=line.thickness_id,
        target_width_mm=221.0,
    )
    assert any(c.id == strip_analog.id for c in candidates)

    assert len(allocations) == 1
    assert allocations[0].material_unit_id == strip_analog.id
    assert allocations[0].meters == 20.0
    assert allocations[0].is_deficit is False
    assert strip_analog.status == UnitStatus.VYDAN_UCHASTKU

def test_strip_pool_adjust_surplus_and_shortage(setup_pogonazh_data):
    """Тест локальной экспресс-инвентаризации пула: оприходование излишка и списание недостачи."""
    from app.services.film_pool import adjust_strip_pool_stock

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    user = d["user"]

    # 1. Сверка при пустом пуле: мастер указывает, что у станка лежит 100м
    res1 = adjust_strip_pool_stock(
        db,
        area="fabrika",
        material_id=sku.material_id,
        color_id=sku.color_id,
        thickness_id=sku.thickness_id,
        target_width_mm=221.0,
        actual_meters=100.0,
        user_id=user.id,
        note="Нашлась пачка штрипса",
    )
    assert res1["ok"] is True
    assert res1["previous_meters"] == 0.0
    assert res1["actual_meters"] == 100.0
    assert res1["delta_meters"] == 100.0
    assert res1["active_units_count"] == 1

    # 2. Мастер уточняет, что фактически осталось 60м (недостача -40м)
    res2 = adjust_strip_pool_stock(
        db,
        area="fabrika",
        material_id=sku.material_id,
        color_id=sku.color_id,
        thickness_id=sku.thickness_id,
        target_width_mm=221.0,
        actual_meters=60.0,
        user_id=user.id,
        note="Замер рулеткой",
    )
    assert res2["ok"] is True
    assert res2["previous_meters"] == 100.0
    assert res2["actual_meters"] == 60.0
    assert res2["delta_meters"] == -40.0

    # 3. Полное списание в 0 (штрипсы кончились)
    res3 = adjust_strip_pool_stock(
        db,
        area="fabrika",
        material_id=sku.material_id,
        color_id=sku.color_id,
        thickness_id=sku.thickness_id,
        target_width_mm=221.0,
        actual_meters=0.0,
        user_id=user.id,
    )
    assert res3["ok"] is True
    assert res3["previous_meters"] == 60.0
    assert res3["actual_meters"] == 0.0
    assert res3["delta_meters"] == -60.0
    assert res3["active_units_count"] == 0


def test_batch_issue_to_area(setup_pogonazh_data):
    """Тест массового перемещения (выдачи) пачки штрипсов со склада на участок Фабрика."""
    from unittest.mock import MagicMock
    from starlette.testclient import TestClient
    from app.core.security import get_current_user
    from app.main import app

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    user = d["user"]

    u1 = MaterialUnit(
        upd_number="UPD-BATCH-1",
        pallet_number="PAL-BATCH",
        material_sku_id=sku.id,
        width_mm=220.0,
        length_m=100.0,
        status=UnitStatus.NA_KHRANENII,
        location_code="СЕВ-01",
        is_strip=True,
    )
    u2 = MaterialUnit(
        upd_number="UPD-BATCH-2",
        pallet_number="PAL-BATCH",
        material_sku_id=sku.id,
        width_mm=220.0,
        length_m=120.0,
        status=UnitStatus.NA_KHRANENII,
        location_code="СЕВ-02",
        is_strip=True,
    )
    db.add_all([u1, u2])
    db.flush()

    mock_user = MagicMock(spec=User)
    mock_user.id = user.id
    mock_user.is_superuser = True
    mock_user.permissions = ["units.issue", "production_tasks.manage"]

    from app.db.session import get_db
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    try:
        res = client.post(
            "/api/units/batch-issue-to-area",
            json={
                "unit_ids": [u1.id, u2.id],
                "area": "fabrika",
                "note": "Пакетная отправка Северный -> Фабрика",
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["ok"] is True
        assert data["issued_count"] == 2
        assert data["total_meters"] == 220.0
        assert data["area"] == "fabrika"

        db.refresh(u1)
        db.refresh(u2)
        assert u1.status == UnitStatus.VYDAN_UCHASTKU
        assert u1.area == "fabrika"
        assert u1.location_code is None
        assert u2.status == UnitStatus.VYDAN_UCHASTKU
        assert u2.area == "fabrika"
    finally:
        app.dependency_overrides.clear()

def test_strip_pool_adjust_api_endpoint(setup_pogonazh_data):
    """Тест эндпоинта POST /api/production/strip-pool/adjust."""
    from unittest.mock import MagicMock
    from starlette.testclient import TestClient
    from app.core.security import get_current_user
    from app.db.session import get_db
    from app.main import app

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    user = d["user"]

    mock_user = MagicMock(spec=User)
    mock_user.id = user.id
    mock_user.is_superuser = True
    mock_user.permissions = ["production_tasks.manage"]

    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    try:
        res = client.post(
            "/api/production-tasks/strip-pool/adjust",
            json={
                "area": "fabrika",
                "material_id": sku.material_id,
                "color_id": sku.color_id,
                "thickness_id": sku.thickness_id,
                "target_width_mm": 221.0,
                "actual_meters": 75.0,
                "note": "API тест сверки",
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["ok"] is True
        assert data["actual_meters"] == 75.0
    finally:
        app.dependency_overrides.clear()


def test_strip_pool_adjust_clears_overdraft_deficit(setup_pogonazh_data):
    """Сверка остатка пула штрипсов автоматически покрывает и обнуляет дефицит (овердрафт)."""
    from app.models.production import ProductionTaskLineReport
    from app.api.production import _line_deficit_aggregates

    d = setup_pogonazh_data
    db = d["db"]
    sku = d["sku"]
    line = d["line"]
    user = d["user"]

    # 1. Генерируем списание в дефицит (на участке 0 штрипсов)
    allocs = consume_film_strips_fifo(
        db,
        line=line,
        area="fabrika",
        good_pieces=5,
        defect_pieces=0,
        user_id=user.id,
    )
    assert len(allocs) == 1
    assert allocs[0].is_deficit is True
    assert allocs[0].material_unit_id is None

    rep = ProductionTaskLineReport(
        task_line_id=line.id,
        material_unit_id=allocs[0].material_unit_id,
        good_pieces=allocs[0].good_pieces,
        defect_pieces=allocs[0].defect_pieces,
        counts_toward_line=True,
        reported_by=user.id,
        note=f"Дефицит плёнки: {allocs[0].meters:.1f} м (нет штрипса на участке)",
    )
    db.add(rep)
    db.flush()

    # До сверки: дефицит 5 шт
    def_before = _line_deficit_aggregates(db, [line.id]).get(line.id, 0.0)
    assert def_before == 5.0

    # 2. Мастер выполняет экспресс-инвентаризацию пула: фактически 50 метров
    res = adjust_strip_pool_stock(
        db,
        area="fabrika",
        material_id=sku.material_id,
        color_id=sku.color_id,
        thickness_id=sku.thickness_id,
        target_width_mm=221.0,
        actual_meters=50.0,
        user_id=user.id,
        note="Сверка пула мастером",
    )
    assert res["ok"] is True
    # Из фактических 50 м вычтен ранее накопленный расход (5 деталей × 2 м).
    assert res["actual_meters"] == 40.0

    # 3. После сверки: дефицит обнулён (0 шт), отчёт привязан к оприходованному юниту
    def_after = _line_deficit_aggregates(db, [line.id]).get(line.id, 0.0)
    assert def_after == 0.0

    db.refresh(rep)
    assert rep.material_unit_id is not None
    assert "Покрыто сверкой пула" in rep.note or "Покрыто инвентаризацией" in rep.note
