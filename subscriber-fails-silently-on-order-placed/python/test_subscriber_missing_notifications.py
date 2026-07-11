from find_missing_subscriber_effects import find_orders_missing_notification

NOW_MS = 1_783_641_600_000  # 2026-07-10T00:00:00Z in epoch ms
GRACE_MS = 10 * 60 * 1000   # 10 minutes


def order(**over):
    base = {"id": "order_1", "created_at": "2026-07-09T23:00:00Z", "fulfillment_status": "not_fulfilled"}
    base.update(over)
    return base


def notification(**over):
    base = {"resource_id": "order_1", "resource_type": "order", "event_name": "order.placed"}
    base.update(over)
    return base


def test_flags_order_past_grace_with_no_notification():
    result = find_orders_missing_notification([order()], [], "order.placed", GRACE_MS, NOW_MS)
    assert result == [{"order_id": "order_1", "expected_event": "order.placed"}]


def test_does_not_flag_when_notification_exists():
    result = find_orders_missing_notification([order()], [notification()], "order.placed", GRACE_MS, NOW_MS)
    assert result == []


def test_does_not_flag_within_grace_window():
    recent = order(created_at="2026-07-09T23:58:00Z")
    result = find_orders_missing_notification([recent], [], "order.placed", GRACE_MS, NOW_MS)
    assert result == []


def test_ignores_notification_for_a_different_event():
    result = find_orders_missing_notification(
        [order()], [notification(event_name="order.fulfillment_created")], "order.placed", GRACE_MS, NOW_MS
    )
    assert result == [{"order_id": "order_1", "expected_event": "order.placed"}]


def test_ignores_notification_for_a_different_resource_type():
    result = find_orders_missing_notification(
        [order()], [notification(resource_type="customer")], "order.placed", GRACE_MS, NOW_MS
    )
    assert result == [{"order_id": "order_1", "expected_event": "order.placed"}]


def test_handles_multiple_orders_independently():
    orders = [order(), order(id="order_2", created_at="2026-07-09T22:00:00Z")]
    notifications = [notification(resource_id="order_2")]
    result = find_orders_missing_notification(orders, notifications, "order.placed", GRACE_MS, NOW_MS)
    assert result == [{"order_id": "order_1", "expected_event": "order.placed"}]
