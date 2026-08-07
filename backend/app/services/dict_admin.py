"""Нечёткий поиск дублей в справочниках атрибутов (админка справочников,
пункт из ТЗ 2.1a) — сравнивает названия попарно через SequenceMatcher, чтобы
подсветить вероятные дубли вроде "Дуб беленый"/"Дуб белёный" уже после того,
как они оба попали в справочник (до этого их подсказки в форме ловит
DictAutoComplete на фронтенде)."""

from dataclasses import dataclass
from difflib import SequenceMatcher


@dataclass(frozen=True)
class DuplicateCandidate:
    a_id: int
    a_name: str
    b_id: int
    b_name: str
    score: float


def _normalize(name: str) -> str:
    return " ".join(name.strip().lower().split())


def find_fuzzy_duplicates(entries: list[tuple[int, str]], threshold: float = 0.82) -> list[DuplicateCandidate]:
    normalized = [(id_, name, _normalize(name)) for id_, name in entries]
    candidates: list[DuplicateCandidate] = []
    for i in range(len(normalized)):
        a_id, a_name, a_norm = normalized[i]
        for j in range(i + 1, len(normalized)):
            b_id, b_name, b_norm = normalized[j]
            if not a_norm or not b_norm:
                continue
            score = 1.0 if a_norm == b_norm else SequenceMatcher(None, a_norm, b_norm).ratio()
            if score >= threshold:
                candidates.append(DuplicateCandidate(a_id, a_name, b_id, b_name, score))
    candidates.sort(key=lambda c: -c.score)
    return candidates
