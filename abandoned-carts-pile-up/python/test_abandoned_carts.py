from datetime import datetime, timezone
from report_stale_carts import classify_stale_cart

NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)


def cart(**over):
    base = {"id": "cart_1", "completed_at": None, "updated_at": "2026-06-01T00:00:00Z", "item_count": 2}
    base.update(over)
    return base


def test_stale_when_old_with_items():
    result = classify_stale_cart(cart(), NOW, 30)
    assert result["stale"] is True
    assert result["reason"].startswith("inactive-")


def test_not_stale_when_completed():
    result = classify_stale_cart(cart(completed_at="2026-06-02T00:00:00Z"), NOW, 30)
    assert result == {"stale": False, "reason": "completed"}


def test_not_stale_when_empty_cart():
    result = classify_stale_cart(cart(item_count=0), NOW, 30)
    assert result == {"stale": False, "reason": "empty-cart-not-abandoned"}


def test_not_stale_when_recent():
    result = classify_stale_cart(cart(updated_at="2026-07-09T00:00:00Z"), NOW, 30)
    assert result == {"stale": False, "reason": "recent"}


def test_exactly_at_stale_window_is_stale():
    result = classify_stale_cart(cart(updated_at="2026-06-10T00:00:00Z"), NOW, 30)
    assert result["stale"] is True


def test_completed_wins_even_with_items_and_age():
    result = classify_stale_cart(cart(completed_at="2026-01-01T00:00:00Z", item_count=5), NOW, 30)
    assert result == {"stale": False, "reason": "completed"}
