from retry_backorder_reservation import decide_reservation_action


def item(**over):
    base = {
        "variant_id": "variant_1",
        "inventory_item_id": "iitem_1",
        "location_id": "sloc_1",
        "allow_backorder": True,
        "manage_inventory": True,
        "stocked_quantity": 0,
        "reserved_quantity": 0,
        "requested_quantity": 1,
    }
    base.update(over)
    return base


def test_noop_when_inventory_not_managed():
    result = decide_reservation_action(item(manage_inventory=False), dry_run=True)
    assert result["action"] == "noop"


def test_noop_when_stock_sufficient():
    result = decide_reservation_action(item(stocked_quantity=5), dry_run=False)
    assert result["action"] == "noop"


def test_noop_when_stock_exactly_meets_requested():
    result = decide_reservation_action(item(stocked_quantity=1, requested_quantity=1), dry_run=False)
    assert result["action"] == "noop"


def test_flag_legitimate_stockout_when_backorder_disabled():
    result = decide_reservation_action(item(allow_backorder=False), dry_run=False)
    assert result["action"] == "flag_legitimate_stockout"


def test_flag_legitimate_stockout_when_backorder_disabled_even_in_dry_run():
    result = decide_reservation_action(item(allow_backorder=False), dry_run=True)
    assert result["action"] == "flag_legitimate_stockout"


def test_flag_when_backorder_enabled_but_dry_run():
    result = decide_reservation_action(item(), dry_run=True)
    assert result["action"] == "flag_legitimate_stockout"


def test_retry_when_backorder_enabled_negative_stock_and_not_dry_run():
    result = decide_reservation_action(item(stocked_quantity=-3), dry_run=False)
    assert result["action"] == "retry_complete"


def test_retry_when_backorder_enabled_zero_stock_and_not_dry_run():
    result = decide_reservation_action(item(stocked_quantity=0), dry_run=False)
    assert result["action"] == "retry_complete"


def test_retry_when_backorder_enabled_positive_but_insufficient_stock():
    result = decide_reservation_action(item(stocked_quantity=1, requested_quantity=5), dry_run=False)
    assert result["action"] == "retry_complete"


def test_noop_takes_priority_over_manage_inventory_flag_shape():
    # manage_inventory falsy values (None) should also short-circuit to noop
    result = decide_reservation_action(item(manage_inventory=None), dry_run=False)
    assert result["action"] == "noop"
