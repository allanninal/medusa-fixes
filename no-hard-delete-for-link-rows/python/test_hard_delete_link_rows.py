from classify_link_rows import classify_link_row


def row(**over):
    base = {"left_id": "prod_1", "right_id": "sc_1", "deleted_at": None}
    base.update(over)
    return base


def test_ok_when_both_parents_live():
    assert classify_link_row(row(), {"prod_1"}, {"sc_1"}) == "ok"


def test_orphan_dangling_when_left_parent_gone():
    result = classify_link_row(row(left_id="prod_999"), {"prod_1"}, {"sc_1"})
    assert result == "orphan_dangling"


def test_orphan_dangling_when_right_parent_gone():
    result = classify_link_row(row(right_id="sc_999"), {"prod_1"}, {"sc_1"})
    assert result == "orphan_dangling"


def test_orphan_dangling_when_both_parents_gone():
    result = classify_link_row(row(left_id="prod_999", right_id="sc_999"), {"prod_1"}, {"sc_1"})
    assert result == "orphan_dangling"


def test_orphan_soft_deleted_even_when_parents_live():
    r = row(deleted_at="2026-07-01T00:00:00Z")
    assert classify_link_row(r, {"prod_1"}, {"sc_1"}) == "orphan_soft_deleted"


def test_orphan_soft_deleted_when_parents_also_gone():
    r = row(left_id="prod_999", deleted_at="2026-07-01T00:00:00Z")
    assert classify_link_row(r, {"prod_1"}, {"sc_1"}) == "orphan_soft_deleted"


def test_empty_live_sets_flags_every_row_as_dangling():
    assert classify_link_row(row(), set(), set()) == "orphan_dangling"
