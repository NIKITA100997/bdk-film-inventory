import pytest
from datetime import date
from app.db.session import SessionLocal
from app.models.dictionaries import Color, Manufacturer, Material, MaterialSku, Thickness
from app.models.production import (
    ProductionLine,
    ProductionTask,
    ProductionTaskLine,
    ProductionTaskLineAssignment,
)
from app.models.units import MaterialUnit, UnitStatus
from app.models.users import User
from app.services.film_pool import consume_film_strips_fifo, get_area_strip_stock


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
