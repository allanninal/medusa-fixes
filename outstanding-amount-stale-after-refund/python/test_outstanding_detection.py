from detect_stale_outstanding import detect_stale_outstanding


def order(**over):
    base = {
        "total": 100.0,
        "captures": [{"amount": 100.0}],
        "refunds": [{"id": "ref_1", "amount": 20.0, "created_at": "2026-07-01T00:00:00Z"}],
        "reportedOutstanding": 0.0,
    }
    base.update(over)
    return base


def test_not_affected_with_a_single_refund_in_sync():
    # One refund, summary correctly reflects it: not the bug.
    result = detect_stale_outstanding(order())
    assert result["affected"] is False
    assert result["refundCount"] == 1


def test_affected_when_second_refund_never_moved_the_summary():
    refunds = [
        {"id": "ref_1", "amount": 20.0, "created_at": "2026-07-01T00:00:00Z"},
        {"id": "ref_2", "amount": 20.0, "created_at": "2026-07-05T00:00:00Z"},
    ]
    # true outstanding = 100 - 100 + 40 = 40, but the summary still reports
    # the balance from after refund #1 only (20.0), so it is stale.
    result = detect_stale_outstanding(order(refunds=refunds, reportedOutstanding=20.0))
    assert result["affected"] is True
    assert result["trueOutstanding"] == 40.0
    assert result["delta"] == -20.0
    assert result["refundCount"] == 2


def test_not_affected_when_multiple_refunds_but_summary_matches():
    refunds = [
        {"id": "ref_1", "amount": 20.0, "created_at": "2026-07-01T00:00:00Z"},
        {"id": "ref_2", "amount": 20.0, "created_at": "2026-07-05T00:00:00Z"},
    ]
    # true outstanding = 100 - 100 + 40 = 40, and summary agrees
    result = detect_stale_outstanding(order(refunds=refunds, reportedOutstanding=40.0))
    assert result["affected"] is False


def test_rounding_epsilon_does_not_false_positive():
    refunds = [
        {"id": "ref_1", "amount": 20.0, "created_at": "2026-07-01T00:00:00Z"},
        {"id": "ref_2", "amount": 20.0, "created_at": "2026-07-05T00:00:00Z"},
    ]
    result = detect_stale_outstanding(order(refunds=refunds, reportedOutstanding=40.005))
    assert result["affected"] is False


def test_true_outstanding_computed_from_captures_and_refunds():
    result = detect_stale_outstanding(order(total=150.0, captures=[{"amount": 100.0}], refunds=[]))
    assert result["trueOutstanding"] == 50.0
    assert result["refundCount"] == 0
    assert result["affected"] is False


def test_single_refund_with_a_mismatch_is_not_flagged():
    # Only one refund event: Medusa handles this case correctly per the
    # research, so we never flag on refund_count == 1 even if numbers differ.
    result = detect_stale_outstanding(order(reportedOutstanding=999.0))
    assert result["affected"] is False
    assert result["refundCount"] == 1


def test_delta_sign_when_reported_is_lower_than_true():
    # true outstanding = 100 - 100 + 40 = 40; reported is only 0.0, so the
    # summary under-reports what is actually still outstanding (delta < 0).
    refunds = [
        {"id": "ref_1", "amount": 20.0, "created_at": "2026-07-01T00:00:00Z"},
        {"id": "ref_2", "amount": 20.0, "created_at": "2026-07-05T00:00:00Z"},
    ]
    result = detect_stale_outstanding(order(refunds=refunds, reportedOutstanding=0.0))
    assert result["affected"] is True
    assert result["delta"] == -40.0
