from find_orphaned_link_rows import classify_link_orphan


def link_row(**over):
    base = {"deleted_at": None}
    base.update(over)
    return base


def test_healthy_when_both_sides_exist():
    assert classify_link_orphan(link_row(), True, True) == "HEALTHY"


def test_already_deleted_when_deleted_at_set():
    row = link_row(deleted_at="2026-07-01T00:00:00Z")
    assert classify_link_orphan(row, True, True) == "ALREADY_DELETED"
    assert classify_link_orphan(row, False, False) == "ALREADY_DELETED"


def test_orphan_left_when_only_left_missing():
    assert classify_link_orphan(link_row(), False, True) == "ORPHAN_LEFT"


def test_orphan_right_when_only_right_missing():
    assert classify_link_orphan(link_row(), True, False) == "ORPHAN_RIGHT"


def test_orphan_both_when_neither_side_exists():
    assert classify_link_orphan(link_row(), False, False) == "ORPHAN_BOTH"


def test_already_deleted_takes_priority_over_orphan_state():
    # Even if both sides are gone, an already soft-deleted row is not a new orphan to report.
    row = link_row(deleted_at="2026-01-01T00:00:00Z")
    assert classify_link_orphan(row, False, True) == "ALREADY_DELETED"
