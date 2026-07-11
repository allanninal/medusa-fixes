from refund_shortfall import compute_refund_shortfall


def payment(captures=None, refunds=None):
    return {
        "id": "pay_1",
        "captures": captures if captures is not None else [{"raw_amount": 100.0}],
        "refunds": refunds if refunds is not None else [],
    }


def test_silently_blocked_when_payment_has_headroom_but_order_reads_zero():
    p = payment(refunds=[{"raw_amount": 40.0}])
    result = compute_refund_shortfall(p, 0)
    assert result["capturedTotal"] == 100.0
    assert result["refundedTotal"] == 40.0
    assert result["shortfall"] == 60.0
    assert result["isSilentlyBlocked"] is True


def test_not_blocked_when_order_still_shows_a_balance():
    p = payment(refunds=[{"raw_amount": 40.0}])
    result = compute_refund_shortfall(p, 60.0)
    assert result["isSilentlyBlocked"] is False


def test_not_blocked_when_fully_refunded():
    p = payment(refunds=[{"raw_amount": 100.0}])
    result = compute_refund_shortfall(p, 0)
    assert result["shortfall"] == 0.0
    assert result["isSilentlyBlocked"] is False


def test_sums_multiple_captures_and_refunds():
    p = payment(
        captures=[{"raw_amount": 50.0}, {"raw_amount": 50.0}],
        refunds=[{"raw_amount": 20.0}, {"raw_amount": 20.0}],
    )
    result = compute_refund_shortfall(p, 0)
    assert result["capturedTotal"] == 100.0
    assert result["refundedTotal"] == 40.0
    assert result["shortfall"] == 60.0
    assert result["isSilentlyBlocked"] is True


def test_negative_order_pending_difference_still_counts_as_blocked():
    p = payment(refunds=[{"raw_amount": 40.0}])
    result = compute_refund_shortfall(p, -5.0)
    assert result["isSilentlyBlocked"] is True


def test_within_epsilon_shortfall_is_not_blocked():
    p = payment(captures=[{"raw_amount": 100.0}], refunds=[{"raw_amount": 99.995}])
    result = compute_refund_shortfall(p, 0)
    assert result["isSilentlyBlocked"] is False


def test_no_captures_means_zero_shortfall():
    p = payment(captures=[], refunds=[])
    result = compute_refund_shortfall(p, 0)
    assert result["capturedTotal"] == 0.0
    assert result["shortfall"] == 0.0
    assert result["isSilentlyBlocked"] is False
