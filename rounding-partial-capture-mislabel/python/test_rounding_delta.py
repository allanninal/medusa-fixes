from clear_rounding_mislabel import classify_capture_delta


def test_sub_cent_remainder_is_cleared():
    result = classify_capture_delta(9.9946, 9.99, 2)
    assert result["action"] == "clear"
    assert result["isRoundingArtifact"] is True
    assert round(result["delta"], 4) == 0.0046


def test_real_outstanding_balance_is_flagged():
    result = classify_capture_delta(10.00, 9.50, 2)
    assert result["action"] == "flag"
    assert result["isRoundingArtifact"] is False


def test_fully_captured_needs_no_action():
    result = classify_capture_delta(10.00, 10.00, 2)
    assert result["action"] == "none"
    assert result["delta"] == 0


def test_overcaptured_needs_no_action():
    result = classify_capture_delta(10.00, 10.01, 2)
    assert result["action"] == "none"


def test_delta_exactly_at_minor_unit_is_flagged_not_cleared():
    result = classify_capture_delta(10.01, 10.00, 2)
    assert result["action"] == "flag"


def test_zero_decimal_currency_scales_minor_unit():
    # JPY has no decimal places, so its minor unit is 1, not 0.01.
    result = classify_capture_delta(1000.4, 1000, 0)
    assert result["action"] == "clear"


def test_zero_decimal_currency_flags_a_full_unit_gap():
    result = classify_capture_delta(1001, 1000, 0)
    assert result["action"] == "flag"


def test_negative_delta_needs_no_action():
    result = classify_capture_delta(9.99, 10.00, 2)
    assert result["action"] == "none"
    assert result["delta"] < 0
