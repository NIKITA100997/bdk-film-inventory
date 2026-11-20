from app.services.task_line_sources import allocate_source_quantities, has_missing_order_source


def test_source_quantities_round_to_the_task_line_total():
    allocations = allocate_source_quantities(
        20,
        {1: 40, 2: 10, 3: 2.5, 4: 27, 5: 2.5},
    )

    assert sum(allocations.values()) == 20
    assert allocations == {1: 9.76, 2: 2.44, 3: 0.61, 4: 6.58, 5: 0.61}


def test_source_quantities_ignore_non_positive_weights():
    allocations = allocate_source_quantities(3, {1: 1, 2: 1, 3: 1, 4: 0, 5: -1})

    assert allocations == {1: 1, 2: 1, 3: 1}


def test_internal_order_without_order_lines_does_not_flag_missing_invoice_source():
    assert not has_missing_order_source(
        part_id=12,
        production_order_id=50,
        source_orders=[],
        orders_with_lines=set(),
    )


def test_customer_order_line_without_recovered_source_is_flagged():
    assert has_missing_order_source(
        part_id=12,
        production_order_id=50,
        source_orders=[],
        orders_with_lines={50},
    )


def test_recovered_source_is_not_flagged():
    assert not has_missing_order_source(
        part_id=12,
        production_order_id=50,
        source_orders=[{"order_line_id": 9}],
        orders_with_lines={50},
    )
