from app.services.normatives import Norms, merge, round_batch, suggest
from app.services.pf_demand import compute_suggestion


def test_no_norms_orders_exact_shortage():
    assert suggest(demand=80, have=30, norms=Norms()) == (80, 50, 50)


def test_min_stock_adds_to_need():
    need, shortage, qty = suggest(demand=0, have=40, norms=Norms(min_stock=100))
    assert (need, shortage, qty) == (100, 60, 60)


def test_min_batch_and_multiple():
    # не хватает 50, партия от 20, кратно 3,6 → 14 × 3,6 = 50,4
    assert suggest(demand=50, have=0, norms=Norms(min_batch=20, batch_multiple=3.6))[2] == 50.4
    # не хватает 5, партия от 20 → 20, кратно 6 → 24
    assert round_batch(5, Norms(min_batch=20, batch_multiple=6)) == 24
    # ровно кратное не округляется вверх лишний раз
    assert round_batch(12, Norms(batch_multiple=6)) == 12


def test_enough_stock_orders_nothing():
    assert suggest(demand=10, have=200, norms=Norms(min_stock=100, min_batch=50, batch_multiple=10))[1:] == (0, 0)


def test_pf_uses_same_rule_with_multiple():
    _, shortage, suggested = compute_suggestion(
        task_demand=30, min_stock=None, stock=0, in_work=10, min_batch=None, batch_multiple=25
    )
    assert (shortage, suggested) == (20, 25)


def test_merge_takes_largest():
    n = merge([Norms(min_stock=100), Norms(min_stock=300, batch_multiple=50), Norms()])
    assert n == Norms(min_stock=300, min_batch=None, batch_multiple=50)
