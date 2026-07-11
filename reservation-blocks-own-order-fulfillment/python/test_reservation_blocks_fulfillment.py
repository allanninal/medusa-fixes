from clear_blocking_reservations import classify_reservation

LEVELS = [{"location_id": "sloc_1", "stocked_quantity": 1, "reserved_quantity": 1}]


def reservation(**over):
    base = {"id": "res_1", "line_item_id": "item_1", "quantity": 1, "location_id": "sloc_1"}
    base.update(over)
    return base


def test_manual_keep_when_no_line_item_id():
    r = reservation(line_item_id=None)
    assert classify_reservation(r, None, LEVELS) == "manual_keep"


def test_orphan_missing_order_when_order_info_is_none():
    r = reservation()
    assert classify_reservation(r, None, LEVELS) == "orphan_missing_order"


def test_orphan_missing_order_when_order_does_not_exist():
    r = reservation()
    order_info = {"exists": False}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_missing_order"


def test_orphan_canceled_order():
    r = reservation()
    order_info = {"exists": True, "status": "canceled", "fulfillment_status": "not_fulfilled"}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_canceled_order"


def test_orphan_archived_order():
    r = reservation()
    order_info = {"exists": True, "status": "archived", "fulfillment_status": "not_fulfilled"}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_canceled_order"


def test_orphan_already_fulfilled():
    r = reservation()
    order_info = {"exists": True, "status": "completed", "fulfillment_status": "fulfilled"}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_already_fulfilled"


def test_orphan_already_shipped():
    r = reservation()
    order_info = {"exists": True, "status": "completed", "fulfillment_status": "shipped"}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_already_fulfilled"


def test_orphan_already_delivered():
    r = reservation()
    order_info = {"exists": True, "status": "completed", "fulfillment_status": "delivered"}
    assert classify_reservation(r, order_info, LEVELS) == "orphan_already_fulfilled"


def test_keep_when_order_is_open_and_unfulfilled():
    r = reservation()
    order_info = {"exists": True, "status": "pending", "fulfillment_status": "not_fulfilled"}
    assert classify_reservation(r, order_info, LEVELS) == "keep"


def test_keep_when_order_is_completed_but_not_yet_fulfilled():
    r = reservation()
    order_info = {"exists": True, "status": "completed", "fulfillment_status": "not_fulfilled"}
    assert classify_reservation(r, order_info, LEVELS) == "keep"
