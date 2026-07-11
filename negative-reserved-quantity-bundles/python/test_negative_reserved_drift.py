from resync_negative_reserved import compute_reserved_quantity_drift


def reservations(*quantities):
    return [{"quantity": q} for q in quantities]


def test_no_resync_when_stored_matches_live_sum():
    result = compute_reserved_quantity_drift(5, reservations(2, 3))
    assert result == {
        "computedReserved": 5,
        "drift": 0,
        "isNegativeAnomaly": False,
        "needsResync": False,
    }


def test_negative_stored_is_flagged_even_if_it_matches_a_negative_sum():
    result = compute_reserved_quantity_drift(-3, reservations())
    assert result["isNegativeAnomaly"] is True
    assert result["needsResync"] is True
    assert result["computedReserved"] == 0
    assert result["drift"] == -3


def test_positive_drift_is_flagged():
    result = compute_reserved_quantity_drift(9, reservations(2, 2))
    assert result["computedReserved"] == 4
    assert result["drift"] == 5
    assert result["isNegativeAnomaly"] is False
    assert result["needsResync"] is True


def test_negative_drift_is_flagged():
    result = compute_reserved_quantity_drift(1, reservations(3, 3))
    assert result["computedReserved"] == 6
    assert result["drift"] == -5
    assert result["needsResync"] is True


def test_empty_reservations_with_zero_stored_needs_no_resync():
    result = compute_reserved_quantity_drift(0, reservations())
    assert result["needsResync"] is False
    assert result["isNegativeAnomaly"] is False


def test_bundle_multiplier_mismatch_example():
    # required_quantity 3, allocate-items reserved 2 orders worth (6), but
    # fulfillment only released 1x per order, leaving reserved_quantity at -3.
    result = compute_reserved_quantity_drift(-3, reservations(6))
    assert result["isNegativeAnomaly"] is True
    assert result["computedReserved"] == 6
    assert result["drift"] == -9
    assert result["needsResync"] is True
