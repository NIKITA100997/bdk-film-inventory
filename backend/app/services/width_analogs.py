"""Аналоги ширин штрипса плёнки (раздел про аналоги ширин при выдаче) —
разные детали могут указывать чуть разную ширину штрипса для одной и той
же на деле взаимозаменяемой плёнки (290/285/287мм у "Стоевой"), и склад
должен уметь выдать любую из них под потребность в любой другой. Группы
заводятся вручную (DictionaryAdmin.tsx → «Аналоги ширин штрипса»), не
автоматическим допуском в мм — см. WidthAnalogGroup."""

from sqlalchemy.orm import Session

from app.models.width_analogs import WidthAnalogMember


def equivalent_widths(db: Session, width_mm: float) -> list[float]:
    """Все ширины из той же группы аналогов, включая саму width_mm. Ширина
    вне всех групп — список из одного элемента (сама она), т.е. поведение
    как раньше (точное совпадение)."""
    store = db.info.get("read_cache")
    cache = None if store is None else store.setdefault("equiv_widths", {})
    if cache is not None and width_mm in cache:
        return cache[width_mm]
    member = db.query(WidthAnalogMember).filter(WidthAnalogMember.width_mm == width_mm).first()
    if member is None:
        out = [width_mm]
    else:
        out = [float(m.width_mm) for m in db.query(WidthAnalogMember).filter(WidthAnalogMember.group_id == member.group_id).all()]
    if cache is not None:
        cache[width_mm] = out
    return out
