from datetime import datetime, timezone
from find_missed_runs import find_missed_runs

NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)
HOURLY = "0 * * * *"


def record(**over):
    base = {"id": "plist_1", "lastRunAt": datetime(2026, 7, 9, 23, 0, 0, tzinfo=timezone.utc)}
    base.update(over)
    return base


def test_not_missed_when_last_run_is_recent():
    result = find_missed_runs([record()], HOURLY, NOW)
    assert result == []


def test_missed_when_last_run_is_far_in_the_past():
    old = record(lastRunAt=datetime(2026, 7, 9, 20, 0, 0, tzinfo=timezone.utc))
    result = find_missed_runs([old], HOURLY, NOW)
    assert len(result) == 1
    assert result[0]["id"] == "plist_1"


def test_missing_last_run_is_always_missed():
    never_run = record(lastRunAt=None)
    result = find_missed_runs([never_run], HOURLY, NOW)
    assert len(result) == 1
    assert result[0]["id"] == "plist_1"


def test_handles_multiple_records_independently_and_sorts_by_missed_by_desc():
    recent = record(id="plist_recent", lastRunAt=datetime(2026, 7, 9, 23, 0, 0, tzinfo=timezone.utc))
    worst = record(id="plist_worst", lastRunAt=datetime(2026, 7, 8, 0, 0, 0, tzinfo=timezone.utc))
    mid = record(id="plist_mid", lastRunAt=datetime(2026, 7, 9, 18, 0, 0, tzinfo=timezone.utc))
    result = find_missed_runs([recent, worst, mid], HOURLY, NOW)
    ids = [r["id"] for r in result]
    assert ids == ["plist_worst", "plist_mid"]


def test_grace_multiplier_widens_the_allowed_gap():
    borderline = record(lastRunAt=datetime(2026, 7, 9, 21, 0, 0, tzinfo=timezone.utc))
    strict = find_missed_runs([borderline], HOURLY, NOW, grace_multiplier=1.0)
    loose = find_missed_runs([borderline], HOURLY, NOW, grace_multiplier=5.0)
    assert len(strict) == 1
    assert len(loose) == 0
