from app.api.items import strip_decor


def test_strip_decor_last_paren_group():
    assert strip_decor("Добор телескоп 10х100х2070 (ПЭТ Бежевый (cream silk))") == "Добор телескоп 10х100х2070"
    assert strip_decor("Наличник телескоп 8х70х2150 (Бьянко)") == "Наличник телескоп 8х70х2150"
    # своя скобка в названии детали остаётся, срезается только декор в конце
    assert strip_decor("Коробка 79х36 (мдф 10+16) (Бьянко)") == "Коробка 79х36 (мдф 10+16)"


def test_strip_decor_leaves_other_names():
    assert strip_decor("Плинтус 16х80х2070") == "Плинтус 16х80х2070"
    assert strip_decor("(Бьянко)") == "(Бьянко)"
