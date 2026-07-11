from datetime import datetime, timezone

from flag_stuck_invoking import is_stuck_invoking, detect_flapping

NOW = datetime(2026, 7, 10, 0, 20, 0, tzinfo=timezone.utc)
NOW_MS = NOW.timestamp() * 1000


def row(**over):
    base = {
        "state": "invoking",
        "workflow_id": "create-order",
        "created_at": datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc),
    }
    base.update(over)
    return base


def test_stuck_when_invoking_past_default_ttl():
    assert is_stuck_invoking(row(), NOW_MS, {}, 10 * 60000) is True


def test_not_stuck_when_within_ttl():
    assert is_stuck_invoking(row(), NOW_MS, {}, 30 * 60000) is False


def test_not_stuck_when_state_is_done():
    assert is_stuck_invoking(row(state="done"), NOW_MS, {}, 5 * 60000) is False


def test_not_stuck_when_state_is_failed():
    assert is_stuck_invoking(row(state="failed"), NOW_MS, {}, 5 * 60000) is False


def test_not_stuck_when_state_is_compensating():
    assert is_stuck_invoking(row(state="compensating"), NOW_MS, {}, 5 * 60000) is False


def test_uses_per_workflow_ttl_override():
    ttl_overrides = {"create-order": 30 * 60000}
    assert is_stuck_invoking(row(), NOW_MS, ttl_overrides, 10 * 60000) is False


def test_ttl_override_can_also_flag_sooner():
    ttl_overrides = {"create-order": 5 * 60000}
    assert is_stuck_invoking(row(), NOW_MS, ttl_overrides, 60 * 60000) is True


def test_falls_back_to_created_at_when_updated_at_missing():
    r = row(updated_at=None, created_at=datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc))
    assert is_stuck_invoking(r, NOW_MS, {}, 10 * 60000) is True


def test_not_stuck_when_no_timestamps_at_all():
    r = row(updated_at=None, created_at=None)
    assert is_stuck_invoking(r, NOW_MS, {}, 1) is False


def test_exactly_at_ttl_boundary_is_not_stuck():
    # Elapsed exactly equals the TTL: the check is strictly greater than.
    r = row(updated_at=datetime(2026, 7, 10, 0, 10, 0, tzinfo=timezone.utc))
    assert is_stuck_invoking(r, NOW_MS, {}, 10 * 60000) is False


def test_detect_flapping_finds_reappeared_transaction():
    ever_seen = {"txn_1", "txn_2"}
    previous = {"txn_2"}  # txn_1 was missing on the last poll
    current = {"txn_1", "txn_2"}  # txn_1 is back
    assert detect_flapping(previous, current, ever_seen) == {"txn_1"}


def test_detect_flapping_empty_when_nothing_reappeared():
    ever_seen = {"txn_1"}
    previous = {"txn_1"}
    current = {"txn_1"}
    assert detect_flapping(previous, current, ever_seen) == set()
