from app.api.search import _matches, search_norm


def test_size_separators_unified():
    assert search_norm("Каркас 24 x 810×2010") == "каркас 24х810х2010"
    assert search_norm("Ёлка") == "елка"


def test_all_words_any_order():
    name = "Стоевая (Панель) 22х120х1976 под 6мм"
    assert _matches(search_norm("1976 стоевая").split(), name)
    assert not _matches(search_norm("стоевая 2035").split(), name)


def test_invoice_number_matches():
    assert _matches(search_norm("1726-вд").split(), "1726-ВД", None)
