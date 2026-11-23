import pytest
from app.db.session import SessionLocal
from app.models.areas import Area
from app.models.dictionaries import Part, PartStage
from app.models.items import Item, ItemComponent, ItemKind, ItemType
from app.models.part_units import PartUnit, PartUnitStatus
from app.models.users import User
from app.services.production_orders import consume_components_at_operation


def test_cross_area_lamination_consumption():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        if not user:
            user = User(username="test_user_cross", full_name="Test User", hashed_password="x", is_active=True)
            db.add(user)
            db.flush()

        # Areas
        press_area = db.query(Area).filter(Area.code == "uchastok_membranno_vakuumnykh_pressov").first()
        if not press_area:
            press_area = Area(code="uchastok_membranno_vakuumnykh_pressov", name="Прессы", is_active=True)
            db.add(press_area)

        fabrika_area = db.query(Area).filter(Area.code == "fabrika").first()
        if not fabrika_area:
            fabrika_area = Area(code="fabrika", name="Фабрика", is_active=True)
            db.add(fabrika_area)
        db.flush()

        # Kinds & Types
        kind_pf = db.query(ItemKind).filter(ItemKind.code == "pf").first()
        if not kind_pf:
            kind_pf = ItemKind(code="pf", name="Полуфабрикат")
            db.add(kind_pf)
            db.flush()

        itype = db.query(ItemType).filter(ItemType.kind_id == kind_pf.id).first()
        if not itype:
            itype = ItemType(kind_id=kind_pf.id, name="Тестовый тип панелей")
            db.add(itype)
            db.flush()

        # Component part (Milled panel)
        comp_item = Item(kind_id=kind_pf.id, type_id=itype.id, name="Тест Панель фрезерованная")
        db.add(comp_item)
        db.flush()

        comp_part = Part(item_id=comp_item.id, name="Тест Панель фрезерованная", width_mm=710.0, length_m=2.01, is_active=True)
        db.add(comp_part)
        db.flush()

        stage_ready = PartStage(
            part_id=comp_part.id,
            name="Готова к ламинации",
            code="gotova_k_laminatsii",
            sequence_order=3,
            area="uchastok_membranno_vakuumnykh_pressov",
        )
        db.add(stage_ready)
        db.flush()

        # PartUnit at stage_ready on press area
        unit = PartUnit(
            part_id=comp_part.id,
            stage_id=stage_ready.id,
            quantity_pieces=80,
            status=PartUnitStatus.VYDAN_UCHASTKU,
            area="uchastok_membranno_vakuumnykh_pressov",
            created_by=user.id,
        )
        db.add(unit)
        db.flush()

        # Parent item (Laminated panel) with lamination stage on fabrika
        parent_item = Item(kind_id=kind_pf.id, type_id=itype.id, name="Тест Панель ламинированная (Аляска)")
        db.add(parent_item)
        db.flush()

        parent_part = Part(item_id=parent_item.id, name="Тест Панель ламинированная", width_mm=710.0, length_m=2.01, is_active=True)
        db.add(parent_part)
        db.flush()

        parent_stage = PartStage(
            item_id=parent_item.id,
            part_id=parent_part.id,
            name="Ламинация",
            code="laminatsiya",
            sequence_order=1,
            area="fabrika",
        )
        db.add(parent_stage)
        db.flush()

        # Component rule
        comp_rule = ItemComponent(
            parent_item_id=parent_item.id,
            component_item_id=comp_item.id,
            qty_per_unit=1.0,
            stage_id=parent_stage.id,
        )
        db.add(comp_rule)
        db.flush()

        # Execute consumption at fabrika for 60 pcs
        written = consume_components_at_operation(
            db, stage=parent_stage, area="fabrika", quantity=60, user_id=user.id
        )

        assert len(written) == 1
        written_unit, qty = written[0]
        assert qty == 60.0
        # The remaining unit in DB should have 20 pcs
        db.refresh(unit)
        assert float(unit.quantity_pieces) == 20.0

    finally:
        db.rollback()
        db.close()
