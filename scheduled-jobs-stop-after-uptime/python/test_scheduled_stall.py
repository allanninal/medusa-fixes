from datetime import datetime, timedelta, timezone
from check_scheduler_heartbeat import is_scheduler_stalled

NOW = datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)
EVERY_MINUTE = "* * * * *"


def test_not_stalled_when_heartbeat_is_recent():
    last_run = NOW - timedelta(seconds=30)
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 3) is False


def test_not_stalled_right_at_the_tolerance_boundary():
    # 60_000ms interval * 3 tolerance = 180s; 179s of silence is still healthy
    last_run = NOW - timedelta(seconds=179)
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 3) is False


def test_stalled_after_twenty_minutes_of_silence_with_default_tolerance():
    last_run = NOW - timedelta(minutes=20)
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 3) is True


def test_higher_tolerance_delays_the_stalled_verdict():
    last_run = NOW - timedelta(minutes=4)
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 3) is True
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 10) is False


def test_works_with_a_five_minute_schedule():
    every_five = "*/5 * * * *"
    healthy = NOW - timedelta(minutes=6)
    stalled = NOW - timedelta(minutes=20)
    assert is_scheduler_stalled(healthy, NOW, every_five, 3) is False
    assert is_scheduler_stalled(stalled, NOW, every_five, 3) is True


def test_exactly_at_tolerance_boundary_is_not_stalled():
    # Interval is 60_000ms, tolerance 3 -> boundary is exactly 180s.
    # gap_ms > threshold uses strict greater-than, so exactly at the
    # boundary should still read as healthy.
    last_run = NOW - timedelta(seconds=180)
    assert is_scheduler_stalled(last_run, NOW, EVERY_MINUTE, 3) is False
