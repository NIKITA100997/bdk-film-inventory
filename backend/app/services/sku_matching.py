"""Подбор позиции номенклатуры (MaterialSku) по сырому тексту цвета —
общая логика для загрузчиков, где цвет/материал даны текстом построчно:
плана заготовок (blank_plan_import.py, инлайн) и наряд-заказа/погонажа
(naryad_import.py, через этот модуль) — оба сталкиваются с одним и тем же:
иногда в тексте только цвет ("Манхэттен"), иногда материал+цвет вместе
("ПЭТ Белый"), и нужно найти позицию номенклатуры, не зная заранее, какой
из случаев перед нами.

blank_plan_import.py оставлен со своей инлайн-копией этой логики
(проверенной вживую на реальных файлах в течение сессии) — не тронута,
чтобы не рисковать регрессией уже работающего; этот модуль — общая точка
для новых мест (naryad_import.py и далее)."""

import difflib
import re
from dataclasses import dataclass

from sqlalchemy.orm import Session, joinedload

from app.models.dictionaries import Color, MaterialSku, Thickness

_SKU_MATCH_CUTOFF = 0.45
_SKU_CANDIDATES_MAX = 5


def sku_label(sku: MaterialSku) -> str:
    return f"{sku.material.name}, {sku.color.name}, {float(sku.thickness.value_mm)} мм"


@dataclass
class SkuMatchIndex:
    color_by_normalized: dict[str, Color]
    skus_by_color_id: dict[int, list[MaterialSku]]
    combined_label_to_sku: dict[str, MaterialSku]


def build_sku_match_index(db: Session) -> SkuMatchIndex:
    colors = db.query(Color).all()
    color_by_normalized = {re.sub(r"\s+", " ", c.name.strip().lower()): c for c in colors}

    # thickness > 0 — отсекает позиции-заглушки (материал "Неизвестно",
    # толщина 0) от подсказки, тот же приём, что в enrich_blank_plan_blocks.
    skus = (
        db.query(MaterialSku)
        .join(Thickness, MaterialSku.thickness_id == Thickness.id)
        .options(joinedload(MaterialSku.material), joinedload(MaterialSku.color), joinedload(MaterialSku.thickness))
        .filter(MaterialSku.is_active, Thickness.value_mm > 0)
        .all()
    )
    skus_by_color_id: dict[int, list[MaterialSku]] = {}
    combined_label_to_sku: dict[str, MaterialSku] = {}
    for s in skus:
        skus_by_color_id.setdefault(s.color_id, []).append(s)
        combined = re.sub(r"\s+", " ", f"{s.material.name} {s.color.name}".strip().lower())
        combined_label_to_sku[combined] = s
    return SkuMatchIndex(color_by_normalized, skus_by_color_id, combined_label_to_sku)


def match_sku_by_color_text(index: SkuMatchIndex, color_text: str) -> tuple[MaterialSku | None, list[dict]]:
    """Сначала точное совпадение цвета (когда в тексте только цвет, и под
    него ровно одна активная позиция), иначе нечёткий поиск по сочетанию
    материал+цвет (когда в тексте материал+цвет вместе, "ПЭТ Белый") —
    одно уверенное совпадение проставляется, несколько похожих отдаются
    списком (sku_candidates) для ручного выбора, не гадаем."""
    color_key = re.sub(r"\s+", " ", color_text.strip().lower())
    color = index.color_by_normalized.get(color_key)
    exact_candidates = index.skus_by_color_id.get(color.id) if color else None
    sku = exact_candidates[0] if exact_candidates and len(exact_candidates) == 1 else None

    sku_candidates: list[dict] = []
    if sku is None:
        combined_labels = list(index.combined_label_to_sku)
        fuzzy_labels = difflib.get_close_matches(color_key, combined_labels, n=_SKU_CANDIDATES_MAX, cutoff=_SKU_MATCH_CUTOFF)
        fuzzy_skus = [index.combined_label_to_sku[label] for label in fuzzy_labels]
        if len(fuzzy_skus) == 1:
            sku = fuzzy_skus[0]
        elif len(fuzzy_skus) > 1:
            ratios = [difflib.SequenceMatcher(None, color_key, label).ratio() for label in fuzzy_labels]
            if ratios[0] >= 0.92 or ratios[0] - ratios[1] >= 0.08:
                sku = fuzzy_skus[0]
            else:
                sku_candidates = [{"sku_id": s.id, "label": sku_label(s)} for s in fuzzy_skus]
    return sku, sku_candidates
