from datetime import date

from app.services.order_needs import NeedRow, OrderNeeds, summary


def _on(oid, rows):
    return OrderNeeds(order_id=oid, name=f"З{oid}", group="принят", priority=0, date=None, rows=rows)


def test_summary_sums_shortage_and_takes_earliest_date():
    a = NeedRow(kind="material", key="item:5", name="МДФ 6", unit="м²", need=100, allocated=40, shortage=60, need_by=date(2026, 10, 20))
    b = NeedRow(kind="material", key="item:5", name="МДФ 6", unit="м²", need=50, allocated=0, shortage=50, need_by=date(2026, 10, 15))
    ok = NeedRow(kind="film", key="film:1-2-3", name="ПЭТ", unit="м²", need=10, allocated=10, shortage=0)
    s = summary([_on(1, [a, ok]), _on(2, [b])])
    assert len(s) == 1
    assert s[0].shortage == 110 and s[0].need_by == date(2026, 10, 15)
    assert [o["order_id"] for o in s[0].orders] == [1, 2]
