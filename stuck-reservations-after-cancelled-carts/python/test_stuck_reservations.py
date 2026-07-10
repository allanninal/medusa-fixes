from datetime import datetime, timezone
from release_stuck_reservations import classify_reservation

NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)
STALE_AFTER_MS = 24 * 3600 * 1000


def reservation(**over):
    base = {"id": "res_1", "line_item_id": "item_1", "created_at": "2026-07-08T00:00:00Z"}
    base.update(over)
    return base


def test_keep_when_no_line_item_id():
    r = reservation(line_item_id=None)
    assert classify_reservation(r, {}, NOW, STALE_AFTER_MS) == "keep"


def test_keep_when_younger_than_stale_window():
    r = reservation(created_at="2026-07-09T23:00:00Z")
    assert classify_reservation(r, {}, NOW, STALE_AFTER_MS) == "keep"


def test_stale_orphan_when_no_matching_order():
    r = reservation()
    assert classify_reservation(r, {}, NOW, STALE_AFTER_MS) == "stale_orphan"


def test_stale_canceled_order_when_order_is_canceled():
    index = {"item_1": {"orderId": "order_1", "orderStatus": "canceled"}}
    r = reservation()
    assert classify_reservation(r, index, NOW, STALE_AFTER_MS) == "stale_canceled_order"


def test_keep_when_order_is_still_active():
    index = {"item_1": {"orderId": "order_1", "orderStatus": "pending"}}
    r = reservation()
    assert classify_reservation(r, index, NOW, STALE_AFTER_MS) == "keep"


def test_exactly_at_stale_window_is_stale():
    r = reservation(created_at="2026-07-09T00:00:00Z")
    assert classify_reservation(r, {}, NOW, STALE_AFTER_MS) == "stale_orphan"


def test_stale_orphan_takes_priority_check_order_first_when_multiple_items():
    index = {"item_2": {"orderId": "order_2", "orderStatus": "completed"}}
    r = reservation(line_item_id="item_1")
    assert classify_reservation(r, index, NOW, STALE_AFTER_MS) == "stale_orphan"
