from detect_multi_group_price_mismatch import detect_stale_price_list_override


def price_list(**over):
    base = {"id": "plist_1", "rules": [{"attribute": "customer.groups.id", "value": ["grp_1", "grp_2"]}]}
    base.update(over)
    return base


def test_flags_multigroup_customer_that_fell_back_to_default():
    result = detect_stale_price_list_override(
        ["grp_1", "grp_9"],
        price_list(),
        {"price_list_id": None, "amount": 1000},
        {"price_list_id": "plist_1", "amount": 800},
    )
    assert result["isAffected"] is True
    assert result["expectedPriceListId"] == "plist_1"


def test_no_mismatch_when_resolved_price_matches():
    result = detect_stale_price_list_override(
        ["grp_1", "grp_9"],
        price_list(),
        {"price_list_id": "plist_1", "amount": 800},
        {"price_list_id": "plist_1", "amount": 800},
    )
    assert result["isAffected"] is False


def test_no_mismatch_when_group_does_not_intersect_rule():
    result = detect_stale_price_list_override(
        ["grp_9", "grp_10"],
        price_list(),
        {"price_list_id": None, "amount": 1000},
        {"price_list_id": None, "amount": 1000},
    )
    assert result["isAffected"] is False


def test_no_mismatch_when_price_list_has_no_group_rule():
    pl = price_list(rules=[{"attribute": "region_id", "value": ["reg_1"]}])
    result = detect_stale_price_list_override(
        ["grp_1"],
        pl,
        {"price_list_id": None, "amount": 1000},
        {"price_list_id": None, "amount": 1000},
    )
    assert result["isAffected"] is False


def test_no_mismatch_when_customer_has_no_groups():
    result = detect_stale_price_list_override(
        [],
        price_list(),
        {"price_list_id": None, "amount": 1000},
        {"price_list_id": None, "amount": 1000},
    )
    assert result["isAffected"] is False


def test_no_mismatch_when_control_also_fell_back():
    # Control fell back too: the price list is probably legitimately inactive
    # rather than affected by the multi-group bug, so this should not flag.
    result = detect_stale_price_list_override(
        ["grp_1", "grp_2"],
        price_list(),
        {"price_list_id": None, "amount": 1000},
        {"price_list_id": None, "amount": 1000},
    )
    assert result["isAffected"] is False


def test_single_group_customer_matching_control_is_not_flagged():
    result = detect_stale_price_list_override(
        ["grp_1"],
        price_list(),
        {"price_list_id": "plist_1", "amount": 800},
        {"price_list_id": "plist_1", "amount": 800},
    )
    assert result["isAffected"] is False
