"""Вывод стабильного code для новой причины (раздел про администрирование
причин брака/списания) — причина заводится через UI текстом ("Название"),
но код остаётся стабильной строкой в БД (это FK, на который ссылаются
MaterialEvent.write_off_reason/ProductionTaskLineReport.defect_reason),
поэтому его не даём вводить руками: транслитерация + kebab/snake из
названия, с проверкой уникальности. Дублирует app/services/areas.py —
тот же приём, другая таблица, общий небольшой хелпер не заводили ради
двух вызывающих мест."""

from sqlalchemy.orm import Session

from app.models.write_off_reasons import WriteOffReasonEntry

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def slugify(name: str) -> str:
    """Транслитерация в code: "Брак поставщика" -> "brak_postavshchika"."""
    lowered = name.strip().lower()
    transliterated = "".join(_TRANSLIT.get(ch, ch) for ch in lowered)
    slug = "".join(ch if ch.isalnum() else "_" for ch in transliterated)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "reason"


def unique_reason_code(db: Session, name: str) -> str:
    base = slugify(name)
    code = base
    suffix = 2
    while db.get(WriteOffReasonEntry, code) is not None:
        code = f"{base}_{suffix}"
        suffix += 1
    return code
