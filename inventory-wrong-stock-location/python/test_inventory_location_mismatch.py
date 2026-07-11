from find_wrong_stock_location import pick_expected_location_id


def level(location_id, stocked_quantity=10):
    return {"location_id": location_id, "stocked_quantity": stocked_quantity}


def test_single_location_matches_and_is_not_a_mismatch():
    result = pick_expected_location_id([level("sloc_a")], ["sloc_a"], "sloc_a")
    assert result == {"expected_location_id": "sloc_a", "is_mismatch": False}


def test_multiple_channel_linked_locations_picks_first_match():
    levels = [level("sloc_b"), level("sloc_a")]
    result = pick_expected_location_id(levels, ["sloc_a", "sloc_b"], "sloc_b")
    assert result["expected_location_id"] == "sloc_b"
    assert result["is_mismatch"] is False


def test_reservation_at_unlinked_location_is_a_mismatch():
    levels = [level("sloc_a")]
    result = pick_expected_location_id(levels, ["sloc_a"], "sloc_z")
    assert result == {"expected_location_id": "sloc_a", "is_mismatch": True}


def test_no_matching_location_returns_none_and_no_mismatch():
    levels = [level("sloc_z")]
    result = pick_expected_location_id(levels, ["sloc_a"], "sloc_z")
    assert result == {"expected_location_id": None, "is_mismatch": False}


def test_reservation_already_correct_is_not_flagged():
    levels = [level("sloc_a"), level("sloc_b")]
    result = pick_expected_location_id(levels, ["sloc_a", "sloc_b"], "sloc_a")
    assert result["is_mismatch"] is False
