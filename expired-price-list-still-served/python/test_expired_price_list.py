from datetime import datetime, timezone

from flag_expired_price_lists import (
    is_price_list_expired_but_active,
    pick_best_calculated_price,
)

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def price_list(**over):
    base = {"status": "active", "ends_at": None}
    base.update(over)
    return base


def test_true_when_active_and_ends_at_in_past():
    pl = price_list(ends_at="2020-01-01T00:00:00+00:00")
    assert is_price_list_expired_but_active(pl, NOW) is True


def test_false_when_ends_at_is_null():
    pl = price_list(ends_at=None)
    assert is_price_list_expired_but_active(pl, NOW) is False


def test_false_when_status_is_draft():
    pl = price_list(status="draft", ends_at="2020-01-01T00:00:00+00:00")
    assert is_price_list_expired_but_active(pl, NOW) is False


def test_false_when_ends_at_in_future():
    pl = price_list(ends_at="2030-01-01T00:00:00+00:00")
    assert is_price_list_expired_but_active(pl, NOW) is False


def test_false_when_ends_at_exactly_now():
    # now must be strictly greater than ends_at to count as expired
    pl = price_list(ends_at="2026-07-10T00:00:00+00:00")
    assert is_price_list_expired_but_active(pl, NOW) is False


def test_pick_best_price_skips_expired_price_list_candidate():
    candidates = [
        {"id": "price_expired", "amount": 10, "price_list_id": "plist_1",
         "price_list_ends_at": "2020-01-01T00:00:00+00:00", "price_list_status": "active"},
        {"id": "price_default", "amount": 50, "price_list_id": None,
         "price_list_ends_at": None, "price_list_status": None},
    ]
    result = pick_best_calculated_price(candidates, NOW)
    assert result == {"id": "price_default", "amount": 50}


def test_pick_best_price_skips_draft_price_list_candidate():
    candidates = [
        {"id": "price_draft", "amount": 5, "price_list_id": "plist_2",
         "price_list_ends_at": None, "price_list_status": "draft"},
        {"id": "price_default", "amount": 50, "price_list_id": None,
         "price_list_ends_at": None, "price_list_status": None},
    ]
    result = pick_best_calculated_price(candidates, NOW)
    assert result == {"id": "price_default", "amount": 50}


def test_pick_best_price_uses_live_active_price_list_when_not_expired():
    candidates = [
        {"id": "price_sale", "amount": 20, "price_list_id": "plist_3",
         "price_list_ends_at": "2030-01-01T00:00:00+00:00", "price_list_status": "active"},
        {"id": "price_default", "amount": 50, "price_list_id": None,
         "price_list_ends_at": None, "price_list_status": None},
    ]
    result = pick_best_calculated_price(candidates, NOW)
    assert result == {"id": "price_sale", "amount": 20}


def test_pick_best_price_returns_none_when_all_candidates_excluded():
    candidates = [
        {"id": "price_expired", "amount": 10, "price_list_id": "plist_4",
         "price_list_ends_at": "2020-01-01T00:00:00+00:00", "price_list_status": "active"},
    ]
    assert pick_best_calculated_price(candidates, NOW) is None


def test_pick_best_price_breaks_ties_by_first_lowest():
    candidates = [
        {"id": "price_a", "amount": 30, "price_list_id": None, "price_list_ends_at": None, "price_list_status": None},
        {"id": "price_b", "amount": 30, "price_list_id": None, "price_list_ends_at": None, "price_list_status": None},
    ]
    result = pick_best_calculated_price(candidates, NOW)
    assert result["amount"] == 30
    assert result["id"] in ("price_a", "price_b")


def test_pick_best_price_empty_list_returns_none():
    assert pick_best_calculated_price([], NOW) is None
