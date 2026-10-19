from app.services.bitrix_deals import parse_title, title_matches


def test_parse_deal_titles():
    assert parse_title("1222-ЛД щиты 100шт. 19.10.2026") == ("1222-ЛД", "щиты", 100)
    assert parse_title("2177-АТ(М) погонаж, 16.10") == ("2177-АТ(М)", "погонаж", None)
    assert parse_title("2180-АТ(М) царга, 3шт, 16.10") == ("2180-АТ(М)", "царга", 3)
    assert parse_title("346-ЛБ Инвизибл 5 шт. 16.10.2026") == ("346-ЛБ", "инвизибл", 5)
    assert parse_title("2069-ДВ+2069-ДВ образцы, царга, 150шт, 12.10")[0] == "2069-ДВ+2069-ДВ"
    assert parse_title("Без номера") == (None, None, None)


def test_deal_matches_invoice():
    assert title_matches("2177-АТ(М) погонаж, 16.10", "2177-АТ(М)")
    assert title_matches("1222-ЛД щиты 100шт.", "1222-ЛД")
    assert not title_matches("12220-ЛД щиты", "1222-ЛД")
