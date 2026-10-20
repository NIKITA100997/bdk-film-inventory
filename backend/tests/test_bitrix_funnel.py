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


def test_ship_date_from_deal_todo(monkeypatch):
    from app.services import bitrix_deals

    acts = [
        {"ID": "1", "OWNER_ID": "10", "DEADLINE": "2026-10-21T11:00:00+03:00", "COMPLETED": "N", "SUBJECT": "1222-ЛД щиты 100шт. 19.10.2026"},
        {"ID": "2", "OWNER_ID": "11", "DEADLINE": "2026-08-07T10:00:00+03:00", "COMPLETED": "N", "SUBJECT": "Связаться с клиентом"},
        {"ID": "3", "OWNER_ID": "12", "DEADLINE": "2026-10-22T10:00:00+03:00", "COMPLETED": "N", "SUBJECT": "Связаться с клиентом"},
        {"ID": "4", "OWNER_ID": "12", "DEADLINE": "2026-10-25T10:00:00+03:00", "COMPLETED": "N", "SUBJECT": "отгрузка"},
        {"ID": "5", "OWNER_ID": "99", "DEADLINE": "2026-10-25T10:00:00+03:00", "COMPLETED": "N", "SUBJECT": "чужая сделка"},
    ]
    monkeypatch.setattr(bitrix_deals.bx, "call", lambda wh, m, p: {"result": acts})
    out = bitrix_deals.todo_ship_dates("wh", {"10", "11", "12"}, {"10": "1222-ЛД щиты 100шт. 19.10.2026", "11": "x", "12": "y"})
    assert out == {"10": "2026-10-21", "12": "2026-10-25"}
