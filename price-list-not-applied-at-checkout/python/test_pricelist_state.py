from datetime import datetime, timezone

from audit_price_lists import get_price_list_effective_state, has_matching_price, audit

NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


def price_list(**over):
    base = {"status": "active", "starts_at": None, "ends_at": None}
    base.update(over)
    return base


def test_draft_wins_regardless_of_dates():
    pl = price_list(status="draft", starts_at="2020-01-01T00:00:00+00:00")
    assert get_price_list_effective_state(pl, NOW) == "draft"


def test_scheduled_when_starts_in_future():
    pl = price_list(starts_at="2030-01-01T00:00:00+00:00")
    assert get_price_list_effective_state(pl, NOW) == "scheduled"


def test_expired_when_ends_in_past():
    pl = price_list(ends_at="2020-01-01T00:00:00+00:00")
    assert get_price_list_effective_state(pl, NOW) == "expired"


def test_active_when_status_active_and_inside_window():
    pl = price_list(starts_at="2020-01-01T00:00:00+00:00", ends_at="2030-01-01T00:00:00+00:00")
    assert get_price_list_effective_state(pl, NOW) == "active"


def test_active_with_no_dates_at_all():
    pl = price_list()
    assert get_price_list_effective_state(pl, NOW) == "active"


def test_matching_price_requires_currency_and_region():
    prices = [{"currency_code": "eur", "rules": {"region_id": "reg_1"}}]
    assert has_matching_price(prices, {"currency_code": "eur", "region_id": "reg_1"}) is True
    assert has_matching_price(prices, {"currency_code": "eur", "region_id": "reg_2"}) is False
    assert has_matching_price(prices, {"currency_code": "usd", "region_id": "reg_1"}) is False


def test_matching_price_with_no_rules_matches_any_region():
    prices = [{"currency_code": "usd"}]
    assert has_matching_price(prices, {"currency_code": "usd", "region_id": "reg_1"}) is True
    assert has_matching_price(prices, {"currency_code": "usd", "region_id": "reg_2"}) is True


def test_audit_flags_scheduled_list():
    price_lists = [{"id": "plist_1", "title": "Summer sale", "status": "active", "starts_at": "2030-01-01T00:00:00+00:00", "ends_at": None, "prices": []}]
    regions = [{"id": "reg_1", "name": "Europe", "currency_code": "eur"}]
    reports = audit(price_lists, regions, NOW)
    assert len(reports) == 1
    assert reports[0]["reason"] == "scheduled"
    assert reports[0]["fix"] is not None


def test_audit_flags_currency_gap_for_active_list():
    price_lists = [{
        "id": "plist_2", "title": "US promo", "status": "active",
        "starts_at": "2020-01-01T00:00:00+00:00", "ends_at": "2030-01-01T00:00:00+00:00",
        "prices": [{"currency_code": "usd"}],
    }]
    regions = [{"id": "reg_eu", "name": "Europe", "currency_code": "eur"}]
    reports = audit(price_lists, regions, NOW)
    assert len(reports) == 1
    assert reports[0]["reason"] == "active-but-no-matching-currency/region-price"


def test_audit_reports_nothing_when_fully_covered():
    price_lists = [{
        "id": "plist_3", "title": "EU promo", "status": "active",
        "starts_at": "2020-01-01T00:00:00+00:00", "ends_at": "2030-01-01T00:00:00+00:00",
        "prices": [{"currency_code": "eur", "rules": {"region_id": "reg_eu"}}],
    }]
    regions = [{"id": "reg_eu", "name": "Europe", "currency_code": "eur"}]
    reports = audit(price_lists, regions, NOW)
    assert reports == []
