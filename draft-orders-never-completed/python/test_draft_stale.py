from datetime import datetime, timezone
from report_stale_draft_orders import is_stale_draft

# Fixed clock: 2026-07-10 00:00:00 UTC, as epoch seconds.
NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc).timestamp()


def order(**over):
    base = {
        "id": "order_1",
        "status": "draft",
        "is_draft_order": True,
        "created_at": "2026-06-01T00:00:00Z",
    }
    base.update(over)
    return base


def test_stale_when_old_draft():
    result = is_stale_draft(order(), NOW, 30)
    assert result["stale"] is True
    assert result["reason"].startswith("draft-")


def test_not_stale_when_not_a_draft():
    result = is_stale_draft(order(status="completed", is_draft_order=False), NOW, 30)
    assert result == {"stale": False, "reason": "not-a-draft"}


def test_not_stale_when_recent_draft():
    result = is_stale_draft(order(created_at="2026-07-09T00:00:00Z"), NOW, 30)
    assert result == {"stale": False, "reason": "recent-draft"}


def test_exactly_at_threshold_is_stale():
    result = is_stale_draft(order(created_at="2026-06-10T00:00:00Z"), NOW, 30)
    assert result["stale"] is True


def test_draft_recognized_by_status_alone():
    result = is_stale_draft(order(is_draft_order=None), NOW, 30)
    assert result["stale"] is True


def test_no_created_at_is_not_stale():
    result = is_stale_draft(order(created_at=None), NOW, 30)
    assert result == {"stale": False, "reason": "no-created-at"}


def test_not_a_draft_wins_even_when_old():
    result = is_stale_draft(order(status="pending", is_draft_order=False, created_at="2026-01-01T00:00:00Z"), NOW, 30)
    assert result == {"stale": False, "reason": "not-a-draft"}
