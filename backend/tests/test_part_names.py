from app.api.items import _similarity
from app.models.items import strip_decor


def test_strip_decor_nested():
    assert strip_decor("Добор телескоп 10х100х2070 (ПЭТ Бежевый (cream silk))") == "Добор телескоп 10х100х2070"
    assert strip_decor("Наличник телескоп 8х70х2150 (Бьянко)") == "Наличник телескоп 8х70х2150"
    assert strip_decor("Филенка 10х220х2050") == "Филенка 10х220х2050"


def test_similarity_word_order_and_size_separators():
    target = "Наличник 8х70х2150 телескоп"
    assert _similarity("Наличник телескоп 8х70х2150", target) > _similarity("Наличник телескоп 8х70х2150", "Добор телескоп 100х2070")
    assert _similarity("Добор телескоп 10*100*2070", "Добор телескоп 10х100х2070") > 0.9


def test_similarity_size_matters():
    a = _similarity("Добор телескоп 10х100х2070", "Добор телескоп 100х2070")
    b = _similarity("Добор телескоп 10х100х2070", "Добор телескоп 150х2070")
    assert a > b
