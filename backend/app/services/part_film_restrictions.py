"""Вывод стабильного code для новой пометки совместимости с плёнкой —
тот же приём, что app/services/write_off_reasons.py (общий хелпер не
заводили там ради двух вызывающих мест, тем более не заводим ради трёх)."""

from sqlalchemy.orm import Session

from app.models.part_film_restrictions import PartFilmRestriction

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name: str) -> str:
    lowered = name.strip().lower()
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in lowered)
    slug = "".join(ch if ch.isalnum() else "_" for ch in transliterated)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "restriction"


def unique_restriction_code(db: Session, name: str) -> str:
    base = slugify(name)
    code = base
    suffix = 2
    while db.get(PartFilmRestriction, code) is not None:
        code = f"{base}_{suffix}"
        suffix += 1
    return code
