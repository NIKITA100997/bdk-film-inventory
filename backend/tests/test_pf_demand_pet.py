from datetime import date

from app.db.session import SessionLocal
from app.models.dictionaries import Color, Material, Part, PartStage
from app.models.items import Item, ItemKind
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.production import ProductionTask, ProductionTaskLine
from app.services.film_check import is_pet_film
from app.services.labels import part_label_data_from_unit
from app.services.part_units import consume_part_units_fifo, mint_part_unit
from app.services.pf_demand import compute_pf_demand


def test_is_pet_film():
    assert is_pet_film("ПЭТ 3Д") is True
    assert is_pet_film("ПЭТ 2Д") is True
    assert is_pet_film("ПЭТ") is True
    assert is_pet_film("PET 3D") is True
    assert is_pet_film("ПВХ", "Белый ПЭТ") is True
    assert is_pet_film("ПВХ", "Дуб сонома") is False
    assert is_pet_film("Полипропилен") is False
    assert is_pet_film(None, None) is False


def test_pf_demand_pet_breakdown():
    db = SessionLocal()
    try:
        kind_pf = db.query(ItemKind).filter_by(code="pf").first()
        if not kind_pf:
            kind_pf = ItemKind(code="pf", name="Полуфабрикаты", unit="шт")
            db.add(kind_pf)
            db.flush()

        item = Item(name="Стоевая 36х108х2035 Тест ПЭТ", kind_id=kind_pf.id)
        db.add(item)
        db.flush()

        part = Part(name=item.name, item_id=item.id, width_mm=108.0, length_m=2.035, is_active=True)
        db.add(part)
        db.flush()

        st1 = PartStage(part_id=part.id, code="okutka", name="Окутка", sequence_order=1, area="okutka_tsargovykh")
        st2 = PartStage(part_id=part.id, code="gotovo", name="Готово", sequence_order=2, area=None)
        db.add_all([st1, st2])
        db.flush()

        # Materials: PET and PVC
        mat_pet = Material(name="ПЭТ Белый Тест")
        mat_pvc = Material(name="ПВХ Дуб Тест")
        color = Color(name="Стандарт Тест")
        db.add_all([mat_pet, mat_pvc, color])
        db.flush()

        # PartUnits: 50 standard and 30 PET
        u_std = mint_part_unit(
            db, part=part, quantity_pieces=50, user_id=1, stage_id=st2.id, note="Стандарт",
            film_restriction=None,
        )
        u_std.status = PartUnitStatus.NA_KHRANENII
        u_pet = mint_part_unit(
            db, part=part, quantity_pieces=30, user_id=1, stage_id=st2.id, note="ПЭТ",
            film_restriction="pet",
        )
        u_pet.status = PartUnitStatus.NA_KHRANENII
        db.flush()

        # Task 1: standard film 40 pcs
        t_std = ProductionTask(name="Задание Стандарт", area="okutka_tsargovykh", is_active=True, created_by=1)
        db.add(t_std)
        db.flush()
        l_std = ProductionTaskLine(
            task_id=t_std.id, part_name=part.name, part_id=part.id,
            material_id=mat_pvc.id, color_id=color.id,
            quantity_pieces=40, width_mm=108, length_m=2.035,
        )
        db.add(l_std)

        # Task 2: PET film 50 pcs (we only have 30 PET stock -> shortage_pet should be 20)
        t_pet = ProductionTask(name="Задание ПЭТ", area="okutka_tsargovykh", is_active=True, created_by=1)
        db.add(t_pet)
        db.flush()
        l_pet = ProductionTaskLine(
            task_id=t_pet.id, part_name=part.name, part_id=part.id,
            material_id=mat_pet.id, color_id=color.id,
            quantity_pieces=50, width_mm=108, length_m=2.035,
        )
        db.add(l_pet)
        db.flush()

        # Run demand calculation
        rows = [r for r in compute_pf_demand(db) if r.part_id == part.id]
        assert len(rows) == 1
        row = rows[0]

        assert row.task_demand == 90.0  # 40 + 50
        assert row.task_demand_pet == 50.0
        assert row.task_demand_standard == 40.0
        assert row.stock == 80.0  # 50 + 30
        assert row.stock_pet == 30.0
        assert row.stock_standard == 50.0
        assert row.shortage_pet == 20.0  # 50 needed - 30 available

        # Check sources
        src_pet = next(s for s in row.sources if s.task_id == t_pet.id)
        assert src_pet.is_pet is True
        src_std = next(s for s in row.sources if s.task_id == t_std.id)
        assert src_std.is_pet is False
    finally:
        db.rollback()
        db.close()


def test_consume_part_units_fifo_soft_priority():
    db = SessionLocal()
    try:
        kind_pf = db.query(ItemKind).filter_by(code="pf").first()
        if not kind_pf:
            kind_pf = ItemKind(code="pf", name="Полуфабрикаты", unit="шт")
            db.add(kind_pf)
            db.flush()

        item = Item(name="Стоевая FIFO Тест", kind_id=kind_pf.id)
        db.add(item)
        db.flush()

        part = Part(name=item.name, item_id=item.id, width_mm=108.0, length_m=2.035, is_active=True)
        db.add(part)
        db.flush()

        st1 = PartStage(part_id=part.id, code="okutka", name="Окутка", sequence_order=1, area="okutka_tsargovykh")
        st2 = PartStage(part_id=part.id, code="gotovo", name="Готово", sequence_order=2, area=None)
        db.add_all([st1, st2])
        db.flush()

        # 1. Standard batch manufactured earlier (date: 2026-01-01)
        u_std = mint_part_unit(
            db, part=part, quantity_pieces=20, user_id=1, stage_id=st1.id,
            manufactured_at=date(2026, 1, 1), film_restriction=None,
        )
        u_std.status = PartUnitStatus.VYDAN_UCHASTKU
        u_std.area = "okutka_tsargovykh"

        # 2. PET batch manufactured later (date: 2026-01-02)
        u_pet = mint_part_unit(
            db, part=part, quantity_pieces=20, user_id=1, stage_id=st1.id,
            manufactured_at=date(2026, 1, 2), film_restriction="pet",
        )
        u_pet.status = PartUnitStatus.VYDAN_UCHASTKU
        u_pet.area = "okutka_tsargovykh"
        db.flush()

        # Case A: When consuming for PET line (is_pet=True), PET batch should be prioritized
        # even though it is newer than standard!
        consumed = consume_part_units_fifo(
            db, part_id=part.id, area="okutka_tsargovykh", quantity_pieces=10,
            user_id=1, is_pet=True,
        )
        assert len(consumed) == 1
        unit_used, _, qty = consumed[0]
        assert unit_used.film_restriction == "pet"
        assert qty == 10

        # Case B: When consuming for standard line (is_pet=False), standard batch should be prioritized
        consumed_std = consume_part_units_fifo(
            db, part_id=part.id, area="okutka_tsargovykh", quantity_pieces=10,
            user_id=1, is_pet=False,
        )
        assert len(consumed_std) == 1
        unit_used_std, _, qty_std = consumed_std[0]
        assert unit_used_std.film_restriction is None
        assert qty_std == 10
    finally:
        db.rollback()
        db.close()


def test_part_label_shows_pet_badge():
    db = SessionLocal()
    try:
        kind_pf = db.query(ItemKind).filter_by(code="pf").first()
        if not kind_pf:
            kind_pf = ItemKind(code="pf", name="Полуфабрикаты", unit="шт")
            db.add(kind_pf)
            db.flush()

        item = Item(name="Филенка 400х800", kind_id=kind_pf.id)
        db.add(item)
        db.flush()

        part = Part(name=item.name, item_id=item.id, width_mm=400.0, length_m=0.8, is_active=True)
        db.add(part)
        db.flush()

        st1 = PartStage(part_id=part.id, code="okutka", name="Окутка", sequence_order=1, area="okutka_tsargovykh")
        db.add(st1)
        db.flush()

        unit_pet = mint_part_unit(
            db, part=part, quantity_pieces=15, user_id=1, stage_id=st1.id,
            film_restriction="pet",
        )
        label_pet = part_label_data_from_unit(unit_pet, db=db)
        assert "[ПЭТ]" in label_pet.part_name

        unit_std = mint_part_unit(
            db, part=part, quantity_pieces=15, user_id=1, stage_id=st1.id,
            film_restriction=None,
        )
        label_std = part_label_data_from_unit(unit_std, db=db)
        assert "[ПЭТ]" not in label_std.part_name
    finally:
        db.rollback()
        db.close()
