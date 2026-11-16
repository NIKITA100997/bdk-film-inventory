from app.db.session import SessionLocal
from app.models.areas import Area
from app.schemas.areas import AreaOut


def test_area_master_profile_fields():
    db = SessionLocal()
    code = "test_custom_milling_area"
    try:
        # Cleanup if exists
        existing = db.query(Area).filter(Area.code == code).first()
        if existing:
            db.delete(existing)
            db.commit()

        # 1. Create with custom profile and flags
        area = Area(
            code=code,
            name="Тестовый участок фрезеровки ЧПУ",
            is_active=True,
            master_profile="milling",
            group_by_attribute="program",
            show_dimensions=True,
            show_cnc_program=True,
            show_edge_specs=False,
            has_pusk_pieces=True,
        )
        db.add(area)
        db.commit()
        db.refresh(area)

        assert area.master_profile == "milling"
        assert area.group_by_attribute == "program"
        assert area.show_dimensions is True
        assert area.show_cnc_program is True
        assert area.show_edge_specs is False
        assert area.has_pusk_pieces is True

        # 2. Check Pydantic AreaOut schema serialization
        out = AreaOut.model_validate(area)
        assert out.master_profile == "milling"
        assert out.group_by_attribute == "program"
        assert out.show_cnc_program is True
        assert out.has_pusk_pieces is True

        # 3. Update to edgebanding profile
        area.master_profile = "edgebanding"
        area.group_by_attribute = "edge"
        area.show_cnc_program = False
        area.show_edge_specs = True
        db.commit()
        db.refresh(area)

        out_updated = AreaOut.model_validate(area)
        assert out_updated.master_profile == "edgebanding"
        assert out_updated.group_by_attribute == "edge"
        assert out_updated.show_edge_specs is True
        assert out_updated.show_cnc_program is False

    finally:
        to_del = db.query(Area).filter(Area.code == code).first()
        if to_del:
            db.delete(to_del)
            db.commit()
        db.close()
