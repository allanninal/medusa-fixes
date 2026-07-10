from detect_unmigrated_link import detect_unmigrated_link


def test_no_link_defined_wins_over_everything_else():
    assert detect_unmigrated_link(10, 0, True, False) == "NO_LINK_DEFINED"


def test_ok_when_no_parent_records_at_all():
    assert detect_unmigrated_link(0, 0, True, True) == "OK"


def test_likely_unmigrated_when_all_empty_but_linked_module_has_rows():
    assert detect_unmigrated_link(50, 0, True, True) == "LIKELY_UNMIGRATED_LINK"


def test_link_not_yet_populated_when_linked_module_is_also_empty():
    assert detect_unmigrated_link(50, 0, False, True) == "LINK_NOT_YET_POPULATED"


def test_ok_when_at_least_one_parent_resolved_the_relation():
    assert detect_unmigrated_link(50, 1, True, True) == "OK"


def test_ok_when_every_parent_resolved_the_relation():
    assert detect_unmigrated_link(50, 50, True, True) == "OK"


def test_no_link_defined_even_with_zero_parent_records():
    assert detect_unmigrated_link(0, 0, False, False) == "NO_LINK_DEFINED"
