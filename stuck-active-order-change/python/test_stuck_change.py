from datetime import datetime, timezone
from reconcile_stuck_order_change import classify_order_change

NOW = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)


def change(**over):
    base = {
        "status": "pending",
        "confirmed_at": None,
        "declined_at": None,
        "canceled_at": None,
        "updated_at": "2026-07-10T09:00:00Z",
    }
    base.update(over)
    return base


def test_stale_stuck_when_pending_and_old():
    assert classify_order_change(change(), NOW, 2) == "active_stale_stuck"


def test_active_fresh_when_pending_and_recent():
    result = classify_order_change(change(updated_at="2026-07-10T11:30:00Z"), NOW, 2)
    assert result == "active_fresh"


def test_terminal_when_confirmed_at_set():
    result = classify_order_change(change(status="confirmed", confirmed_at="2026-07-10T09:00:00Z"), NOW, 2)
    assert result == "terminal"


def test_terminal_when_declined_at_set():
    result = classify_order_change(change(status="declined", declined_at="2026-07-10T09:00:00Z"), NOW, 2)
    assert result == "terminal"


def test_terminal_when_canceled_at_set():
    result = classify_order_change(change(status="canceled", canceled_at="2026-07-10T09:00:00Z"), NOW, 2)
    assert result == "terminal"


def test_terminal_when_status_not_active():
    result = classify_order_change(change(status="confirmed"), NOW, 2)
    assert result == "terminal"


def test_exactly_at_threshold_is_not_yet_stale():
    result = classify_order_change(change(updated_at="2026-07-10T10:00:00Z"), NOW, 2)
    assert result == "active_fresh"


def test_just_past_threshold_is_stale():
    result = classify_order_change(change(updated_at="2026-07-10T09:59:59Z"), NOW, 2)
    assert result == "active_stale_stuck"


def test_terminal_wins_even_if_status_still_pending():
    # Defensive: if a terminal timestamp is set but status was not updated yet,
    # terminal must still win, matching getActiveOrderChange_'s exclusion.
    result = classify_order_change(change(canceled_at="2026-07-10T09:00:00Z"), NOW, 2)
    assert result == "terminal"


def test_find_stuck_changes_skips_orders_without_a_change():
    from reconcile_stuck_order_change import find_stuck_changes

    orders = [
        {"id": "order_1", "display_id": 1, "order_change": None},
        {
            "id": "order_2",
            "display_id": 2,
            "order_change": {
                "id": "ordch_1",
                "status": "pending",
                "confirmed_at": None,
                "declined_at": None,
                "canceled_at": None,
                "updated_at": "2026-07-10T09:00:00Z",
            },
        },
        {
            "id": "order_3",
            "display_id": 3,
            "order_change": {
                "id": "ordch_2",
                "status": "pending",
                "confirmed_at": None,
                "declined_at": None,
                "canceled_at": None,
                "updated_at": "2026-07-10T11:55:00Z",
            },
        },
    ]

    stuck = find_stuck_changes(orders, NOW, 2)
    assert len(stuck) == 1
    assert stuck[0]["order_id"] == "order_2"
    assert stuck[0]["order_change_id"] == "ordch_1"
