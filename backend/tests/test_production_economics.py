"""Служебные записи отчётов узнаются по виду записи, а не по тексту примечания."""

from types import SimpleNamespace

from app.models.production import REPORT_CLOSE, REPORT_RECON, REPORT_REMAINDER
from app.services.production_economics import _is_film_adjustment


def _rep(kind, note="", counts=False):
    return SimpleNamespace(kind=kind, note=note, counts_toward_line=counts)


def test_adjustments_by_kind():
    assert _is_film_adjustment(_rep(REPORT_RECON))
    assert _is_film_adjustment(_rep(REPORT_REMAINDER))
    assert not _is_film_adjustment(_rep(REPORT_CLOSE, counts=True))
    assert not _is_film_adjustment(_rep(None))


def test_note_text_no_longer_matters():
    # примечание поменяли — запись остаётся обычной, пока вид не задан
    assert not _is_film_adjustment(_rep(None, note="Расход досчитан при возврате: остаток 5 м"))
    assert _is_film_adjustment(_rep(REPORT_RECON, note="любой текст"))
