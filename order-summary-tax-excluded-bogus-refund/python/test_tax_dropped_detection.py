from detect_tax_dropped_from_summary import detect_tax_dropped_from_summary


def order(**over):
    base = {
        "total": 120.0,
        "tax_total": 20.0,
        "summary": {
            "accounting_total": 100.0,
            "current_order_total": 100.0,
            "pending_difference": -20.0,
            "paid_total": 120.0,
        },
    }
    base.update(over)
    return base


def test_affected_when_drift_matches_tax_total():
    result = detect_tax_dropped_from_summary(order())
    assert result["affected"] is True
    assert result["drift"] == 20.0
    assert result["correctedPendingDifference"] == 0.0


def test_not_affected_when_no_tax_on_order():
    o = order(tax_total=0.0, total=100.0)
    o["summary"]["accounting_total"] = 100.0
    result = detect_tax_dropped_from_summary(o)
    assert result["affected"] is False


def test_not_affected_with_legitimate_partial_refund():
    # summary correctly reflects a partial refund, drift does not match tax
    o = order()
    o["summary"]["accounting_total"] = 110.0  # only $10 off, not the $20 tax
    result = detect_tax_dropped_from_summary(o)
    assert result["affected"] is False


def test_rounding_noise_within_epsilon_still_affected():
    o = order()
    o["summary"]["accounting_total"] = 100.004
    result = detect_tax_dropped_from_summary(o)
    assert result["affected"] is True


def test_rounding_noise_outside_epsilon_not_affected():
    o = order()
    o["summary"]["accounting_total"] = 99.9  # off by 0.1 beyond the 20.0 tax match
    result = detect_tax_dropped_from_summary(o)
    assert result["affected"] is False


def test_corrected_pending_difference_uses_total_minus_paid():
    o = order(total=150.0)
    o["summary"]["paid_total"] = 90.0
    result = detect_tax_dropped_from_summary(o)
    assert result["correctedPendingDifference"] == 60.0
