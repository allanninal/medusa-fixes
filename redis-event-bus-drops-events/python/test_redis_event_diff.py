from reconcile_event_delivery import diff_event_delivery

WINDOW_START = "2026-07-09T00:00:00Z"
WINDOW_END = "2026-07-10T00:00:00Z"


def order(**over):
    base = {"id": "order_1", "created_at": "2026-07-09T12:00:00Z"}
    base.update(over)
    return base


def notification(**over):
    base = {
        "resource_id": "order_1",
        "resource_type": "order",
        "event_name": "order.placed",
        "created_at": "2026-07-09T12:00:10Z",
    }
    base.update(over)
    return base


def test_delivered_when_notification_arrives_quickly():
    result = diff_event_delivery([order()], [notification()], WINDOW_START, WINDOW_END)
    assert result == [{"order_id": "order_1", "status": "delivered", "delay_ms": 10000}]


def test_delayed_when_notification_arrives_past_threshold():
    late = notification(created_at="2026-07-09T12:05:00Z")
    result = diff_event_delivery([order()], [late], WINDOW_START, WINDOW_END, delay_threshold_ms=60000)
    assert result == [{"order_id": "order_1", "status": "delayed", "delay_ms": 300000}]


def test_dropped_when_no_matching_notification():
    result = diff_event_delivery([order()], [], WINDOW_START, WINDOW_END)
    assert result == [{"order_id": "order_1", "status": "dropped", "delay_ms": None}]


def test_ignores_notification_for_a_different_event():
    other_event = notification(event_name="order.fulfillment_created")
    result = diff_event_delivery([order()], [other_event], WINDOW_START, WINDOW_END)
    assert result == [{"order_id": "order_1", "status": "dropped", "delay_ms": None}]


def test_ignores_notification_for_a_different_resource_type():
    other_type = notification(resource_type="customer")
    result = diff_event_delivery([order()], [other_type], WINDOW_START, WINDOW_END)
    assert result == [{"order_id": "order_1", "status": "dropped", "delay_ms": None}]


def test_uses_the_earliest_matching_notification():
    first = notification(created_at="2026-07-09T12:00:05Z")
    second = notification(created_at="2026-07-09T12:10:00Z")
    result = diff_event_delivery([order()], [second, first], WINDOW_START, WINDOW_END)
    assert result == [{"order_id": "order_1", "status": "delivered", "delay_ms": 5000}]


def test_handles_multiple_orders_independently():
    orders = [order(), order(id="order_2", created_at="2026-07-09T13:00:00Z")]
    notifications = [notification()]
    result = diff_event_delivery(orders, notifications, WINDOW_START, WINDOW_END)
    assert result == [
        {"order_id": "order_1", "status": "delivered", "delay_ms": 10000},
        {"order_id": "order_2", "status": "dropped", "delay_ms": None},
    ]


def test_exactly_at_threshold_is_delivered():
    at_threshold = notification(created_at="2026-07-09T12:01:00Z")
    result = diff_event_delivery([order()], [at_threshold], WINDOW_START, WINDOW_END, delay_threshold_ms=60000)
    assert result == [{"order_id": "order_1", "status": "delivered", "delay_ms": 60000}]
