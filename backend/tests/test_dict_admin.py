from app.services.dict_admin import find_fuzzy_duplicates


def test_exact_match_after_normalization():
    candidates = find_fuzzy_duplicates([(1, "Дуб беленый"), (2, "  дуб   беленый  ")])
    assert len(candidates) == 1
    assert candidates[0].score == 1.0
    assert {candidates[0].a_id, candidates[0].b_id} == {1, 2}


def test_close_typo_is_flagged():
    candidates = find_fuzzy_duplicates([(1, "Дуб беленый"), (2, "Дуб белёный")])
    assert len(candidates) == 1
    assert candidates[0].score >= 0.82


def test_unrelated_names_not_flagged():
    candidates = find_fuzzy_duplicates([(1, "Дуб беленый"), (2, "Орех темный")])
    assert candidates == []


def test_below_threshold_excluded():
    candidates = find_fuzzy_duplicates([(1, "АБВ"), (2, "АБГ")], threshold=0.9)
    assert candidates == []


def test_results_sorted_by_score_descending():
    candidates = find_fuzzy_duplicates(
        [(1, "Классен"), (2, "Класcен"), (3, "Класен")],
        threshold=0.7,
    )
    scores = [c.score for c in candidates]
    assert scores == sorted(scores, reverse=True)


def test_empty_name_skipped():
    candidates = find_fuzzy_duplicates([(1, ""), (2, "")])
    assert candidates == []
