"""Вывод стабильного code для нового участка (раздел про администрирование
участков) — участок теперь заводится через UI текстом ("Название"), но
код остаётся стабильной строкой в БД (как и было при enum), поэтому его
не даём вводить руками: транслитерация + kebab/snake из названия, с
проверкой уникальности."""

from sqlalchemy.orm import Session

from app.models.areas import Area

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name: str) -> str:
    """Транслитерация в code: "Окутка царговых" -> "okutka_tsargovykh"."""
    lowered = name.strip().lower()
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in lowered)
    slug = "".join(ch if ch.isalnum() else "_" for ch in transliterated)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "area"


def unique_area_code(db: Session, name: str) -> str:
    base = slugify(name)
    code = base
    suffix = 2
    while db.get(Area, code) is not None:
        code = f"{base}_{suffix}"
        suffix += 1
    return code
