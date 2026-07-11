from find_missed_events import find_missed_event_windows

LOADER_DONE_AT_MS = 1_000_000


def entry(**over):
    base = {"event": "order.placed", "atMs": 900_000}
    base.update(over)
    return base


def test_event_before_loader_done_is_missed():
    result = find_missed_event_windows([entry()], LOADER_DONE_AT_MS)
    assert len(result) == 1
    assert result[0]["event"] == "order.placed"
    assert result[0]["gapMs"] == 100_000


def test_event_after_loader_done_is_not_missed():
    result = find_missed_event_windows([entry(atMs=1_100_000)], LOADER_DONE_AT_MS)
    assert result == []


def test_event_exactly_at_loader_done_is_not_missed():
    result = find_missed_event_windows([entry(atMs=LOADER_DONE_AT_MS)], LOADER_DONE_AT_MS)
    assert result == []


def test_handles_multiple_events_independently():
    early = entry(event="cart.completed", atMs=500_000)
    late = entry(event="customer.created", atMs=1_200_000)
    result = find_missed_event_windows([entry(), early, late], LOADER_DONE_AT_MS)
    events = [r["event"] for r in result]
    assert events == ["order.placed", "cart.completed"]


def test_empty_boot_log_returns_empty():
    assert find_missed_event_windows([], LOADER_DONE_AT_MS) == []


def test_gap_ms_matches_the_difference_exactly():
    result = find_missed_event_windows([entry(atMs=250_000)], LOADER_DONE_AT_MS)
    assert result[0]["gapMs"] == 750_000
