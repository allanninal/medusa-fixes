from find_duplicate_confirmations import find_duplicate_notifications


def notification(**over):
    base = {
        "id": "notif_1",
        "resource_id": "order_1",
        "resource_type": "order",
        "to": "buyer@example.com",
        "created_at": "2026-07-10T12:00:00Z",
    }
    base.update(over)
    return base


def test_flags_two_sends_within_window():
    notifications = [
        notification(id="notif_1", created_at="2026-07-10T12:00:00Z"),
        notification(id="notif_2", created_at="2026-07-10T12:00:20Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == [{"order_id": "order_1", "count": 2, "notification_ids": ["notif_1", "notif_2"]}]


def test_does_not_flag_a_single_send():
    result = find_duplicate_notifications([notification()], window_ms=60000)
    assert result == []


def test_does_not_flag_sends_outside_the_window():
    notifications = [
        notification(id="notif_1", created_at="2026-07-10T12:00:00Z"),
        notification(id="notif_2", created_at="2026-07-10T12:05:00Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == []


def test_ignores_non_order_resource_type():
    notifications = [
        notification(id="notif_1", resource_type="customer"),
        notification(id="notif_2", resource_type="customer", created_at="2026-07-10T12:00:10Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == []


def test_does_not_cluster_different_recipients():
    notifications = [
        notification(id="notif_1", to="buyer@example.com"),
        notification(id="notif_2", to="other@example.com", created_at="2026-07-10T12:00:10Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == []


def test_handles_multiple_orders_independently():
    notifications = [
        notification(id="notif_1", resource_id="order_1", created_at="2026-07-10T12:00:00Z"),
        notification(id="notif_2", resource_id="order_1", created_at="2026-07-10T12:00:10Z"),
        notification(id="notif_3", resource_id="order_2", created_at="2026-07-10T13:00:00Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == [{"order_id": "order_1", "count": 2, "notification_ids": ["notif_1", "notif_2"]}]


def test_three_sends_in_one_cluster():
    notifications = [
        notification(id="notif_1", created_at="2026-07-10T12:00:00Z"),
        notification(id="notif_2", created_at="2026-07-10T12:00:10Z"),
        notification(id="notif_3", created_at="2026-07-10T12:00:20Z"),
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == [{"order_id": "order_1", "count": 3, "notification_ids": ["notif_1", "notif_2", "notif_3"]}]


def test_exactly_at_window_boundary_is_clustered():
    notifications = [
        notification(id="notif_1", created_at="2026-07-10T12:00:00Z"),
        notification(id="notif_2", created_at="2026-07-10T12:01:00Z"),  # exactly 60000ms later
    ]
    result = find_duplicate_notifications(notifications, window_ms=60000)
    assert result == [{"order_id": "order_1", "count": 2, "notification_ids": ["notif_1", "notif_2"]}]
