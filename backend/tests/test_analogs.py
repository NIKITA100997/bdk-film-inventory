from dataclasses import dataclass

from app.services.analogs import analog_sku_of


@dataclass
class _FakeLink:
    sku_id: int
    analog_sku_id: int
    sku: str
    analog_sku: str


def test_analog_sku_of_returns_other_side_when_queried_from_sku():
    link = _FakeLink(sku_id=1, analog_sku_id=2, sku="A", analog_sku="B")
    assert analog_sku_of(link, sku_id=1) == "B"


def test_analog_sku_of_returns_other_side_when_queried_from_analog_sku():
    """Связь ненаправленная по смыслу (см. модель SkuAnalog) — просмотр со
    стороны analog_sku_id должен вернуть исходную sku, а не саму себя."""
    link = _FakeLink(sku_id=1, analog_sku_id=2, sku="A", analog_sku="B")
    assert analog_sku_of(link, sku_id=2) == "A"
