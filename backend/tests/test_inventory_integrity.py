from unittest.mock import MagicMock, patch
import pytest

from app.models.items import MOVE_ADJUST, MOVE_WRITEOFF, Item
from app.models.part_units import PartUnit
from app.services import materials, part_units


def test_material_write_off_hard_stop():
    db = MagicMock()
    item = Item(id=1, name="Тестовый клей", unit="кг")
    item.kind = MagicMock(code="material")

    with patch("app.services.materials.balances", return_value={1: 50.0}):
        # Writing off 80 when balance is 50 should raise ValueError
        with pytest.raises(ValueError) as exc:
            materials.manual_move(db, item=item, kind=MOVE_WRITEOFF, qty=80.0, user_id=1, note="В цех")
        assert "на складе числится 50" in str(exc.value)
        assert "Выполните инвентаризацию или оприходование" in str(exc.value)

        # Writing off 30 when balance is 50 should succeed
        with patch("app.services.materials.record") as mock_record:
            materials.manual_move(db, item=item, kind=MOVE_WRITEOFF, qty=30.0, user_id=1, note="В цех")
            mock_record.assert_called_once()
            _, kwargs = mock_record.call_args
            assert kwargs["qty"] == -30.0


def test_material_regrade_hard_stop():
    db = MagicMock()
    src = Item(id=1, name="Клей А", unit="кг")
    src.kind = MagicMock(code="material")
    dst = Item(id=2, name="Клей Б", unit="кг")
    dst.kind = MagicMock(code="material")

    with patch("app.services.materials.balances", return_value={1: 25.0}):
        with pytest.raises(ValueError) as exc:
            materials.regrade(db, src=src, dst=dst, qty=30.0, user_id=1, reason="Пересорт")
        assert "на складе числится 25" in str(exc.value)
        assert "Выполните инвентаризацию или оприходование" in str(exc.value)


def test_part_unit_split_or_reuse_hard_stop():
    db = MagicMock()
    unit = PartUnit(id=10, part_id=100, quantity_pieces=50.0)
    unit.part = MagicMock(name="Стоевая царги")

    with pytest.raises(ValueError) as exc:
        part_units._split_or_reuse(db, unit, 70.0)
    assert "в партии числится 50" in str(exc.value)
    assert "Выполните инвентаризацию или оприходование" in str(exc.value)
