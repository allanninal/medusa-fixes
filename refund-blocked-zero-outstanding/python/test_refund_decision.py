from refund_from_ledger import decide_refund


def payment(**over):
    base = {"amount": 100.0, "amount_refunded": 0.0, "captured_at": "2026-07-01T00:00:00Z"}
    base.update(over)
    return base


def summary(**over):
    base = {"transaction_total": 100.0, "paid_total": 100.0, "refunded_total": 0.0}
    base.update(over)
    return base


def test_allows_refund_when_captured_and_summary_agrees():
    result = decide_refund(payment(), summary(), 100.0)
    assert result["allow"] is True
    assert result["refundable_amount"] == "100.0"
    assert result["reason"] is None


def test_blocks_when_not_captured():
    result = decide_refund(payment(captured_at=None), summary(), 100.0)
    assert result["allow"] is False
    assert result["reason"] == "not_captured"


def test_blocks_when_requested_exceeds_refundable():
    result = decide_refund(payment(amount_refunded=40.0), summary(refunded_total=0.0), 100.0)
    assert result["allow"] is False
    assert result["reason"] == "exceeds_refundable"


def test_allows_when_summary_reads_zero_outstanding_but_payment_is_captured():
    # This is the exact bug: the order summary thinks nothing is owed,
    # but the payment ledger says it is still fully refundable.
    result = decide_refund(payment(), summary(paid_total=100.0, refunded_total=100.0), 100.0)
    assert result["allow"] is True
    assert result["reason"] == "summary_outstanding_zero_but_payment_captured"
    assert result["refundable_amount"] == "100.0"


def test_partial_refund_within_remaining_amount():
    result = decide_refund(payment(amount_refunded=60.0), summary(refunded_total=60.0), 40.0)
    assert result["allow"] is True
    assert result["refundable_amount"] == "40.0"


def test_zero_refundable_payment_is_not_allowed_for_positive_request():
    result = decide_refund(payment(amount_refunded=100.0), summary(refunded_total=100.0), 1.0)
    assert result["allow"] is False
    assert result["reason"] == "exceeds_refundable"


def test_requesting_exactly_the_refundable_amount_is_allowed():
    result = decide_refund(payment(amount=250.0, amount_refunded=0.0), summary(paid_total=250.0, refunded_total=0.0), 250.0)
    assert result["allow"] is True
    assert result["refundable_amount"] == "250.0"
