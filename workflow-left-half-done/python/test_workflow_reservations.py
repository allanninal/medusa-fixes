from reconcile_half_run_workflows import classify_reservation

NOW = "2026-07-10T00:20:00+00:00"


def reservation(**over):
    base = {"id": "res_1", "line_item_id": "item_1", "created_at": "2026-07-10T00:00:00+00:00"}
    base.update(over)
    return base


def test_healthy_when_no_line_item_id():
    r = reservation(line_item_id=None)
    assert classify_reservation(r, None, NOW, 10) == "healthy"


def test_orphaned_no_order_when_order_missing():
    r = reservation()
    assert classify_reservation(r, None, NOW, 10) == "orphaned_no_order"


def test_orphaned_canceled_order_when_order_canceled():
    order = {"id": "order_1", "status": "canceled"}
    r = reservation()
    assert classify_reservation(r, order, NOW, 10) == "orphaned_canceled_order"


def test_healthy_when_order_pending_even_if_old():
    order = {"id": "order_1", "status": "pending"}
    r = reservation()
    assert classify_reservation(r, order, NOW, 10) == "healthy"


def test_stale_pending_review_when_old_and_order_in_limbo():
    order = {"id": "order_1", "status": "requires_action"}
    r = reservation()
    assert classify_reservation(r, order, NOW, 10) == "stale_pending_review"


def test_healthy_when_young_even_if_order_in_limbo():
    order = {"id": "order_1", "status": "requires_action"}
    r = reservation(created_at="2026-07-10T00:15:00+00:00")
    assert classify_reservation(r, order, NOW, 10) == "healthy"


def test_healthy_when_order_completed_even_if_old():
    order = {"id": "order_1", "status": "completed"}
    r = reservation()
    assert classify_reservation(r, order, NOW, 10) == "healthy"
