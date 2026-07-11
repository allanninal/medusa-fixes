from find_blocked_cancels import is_cancel_blocked_by_negative_stock


def fulfillment(**over):
    base = {"id": "ful_1", "canceled_at": None}
    base.update(over)
    return base


def level(**over):
    base = {"stocked_quantity": 5, "reserved_quantity": 3}
    base.update(over)
    return base


def test_blocked_when_available_is_negative():
    lvl = level(stocked_quantity=2, reserved_quantity=5)
    assert is_cancel_blocked_by_negative_stock(fulfillment(), lvl) is True


def test_not_blocked_when_available_is_zero():
    lvl = level(stocked_quantity=5, reserved_quantity=5)
    assert is_cancel_blocked_by_negative_stock(fulfillment(), lvl) is False


def test_not_blocked_when_available_is_positive():
    assert is_cancel_blocked_by_negative_stock(fulfillment(), level()) is False


def test_not_blocked_when_already_canceled():
    lvl = level(stocked_quantity=1, reserved_quantity=9)
    assert is_cancel_blocked_by_negative_stock(fulfillment(canceled_at="2026-07-01T00:00:00Z"), lvl) is False


def test_not_blocked_when_no_location_level():
    assert is_cancel_blocked_by_negative_stock(fulfillment(), None) is False


def test_not_blocked_when_quantities_missing():
    lvl = level(stocked_quantity=None, reserved_quantity=None)
    assert is_cancel_blocked_by_negative_stock(fulfillment(), lvl) is False


def test_blocked_exactly_one_unit_short():
    lvl = level(stocked_quantity=4, reserved_quantity=5)
    assert is_cancel_blocked_by_negative_stock(fulfillment(), lvl) is True
