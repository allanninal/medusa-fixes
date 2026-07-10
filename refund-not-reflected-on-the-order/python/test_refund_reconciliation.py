from reconcile_refunds import decide_refund_reconciliation


def order(paid_total=100.0, refunded_total=0.0, payments=None):
    return {
        "id": "order_1",
        "summary": {
            "paid_total": paid_total,
            "refunded_total": refunded_total,
            "transaction_total": paid_total,
            "accounting_total": paid_total - refunded_total,
        },
        "payment_collections": [
            {"status": "authorized", "payments": payments or []}
        ],
    }


def payment(amount=100.0, refunds=None):
    return {"amount": amount, "captured_at": "2026-07-01T00:00:00Z", "refunds": refunds or []}


def test_in_sync_when_ledger_matches_order():
    o = order(refunded_total=20.0, payments=[payment(refunds=[{"amount": 20.0, "created_at": "2026-07-02T00:00:00Z"}])])
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is False
    assert result["reason"] == "in_sync"
    assert result["delta"] == 0.0


def test_refund_not_reflected_when_ledger_ahead():
    o = order(refunded_total=0.0, payments=[payment(refunds=[{"amount": 25.0, "created_at": "2026-07-02T00:00:00Z"}])])
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is True
    assert result["reason"] == "refund_not_reflected"
    assert result["ledgerRefundedTotal"] == 25.0
    assert result["delta"] == 25.0


def test_over_refunded_on_order_when_order_ahead():
    o = order(refunded_total=30.0, payments=[payment(refunds=[{"amount": 10.0, "created_at": "2026-07-02T00:00:00Z"}])])
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is True
    assert result["reason"] == "over_refunded_on_order"
    assert result["delta"] == -20.0


def test_sums_refunds_across_multiple_payments():
    o = order(
        refunded_total=15.0,
        payments=[
            payment(amount=50.0, refunds=[{"amount": 10.0, "created_at": "2026-07-02T00:00:00Z"}]),
            payment(amount=50.0, refunds=[{"amount": 5.0, "created_at": "2026-07-03T00:00:00Z"}]),
        ],
    )
    result = decide_refund_reconciliation(o)
    assert result["ledgerRefundedTotal"] == 15.0
    assert result["needsSync"] is False


def test_within_epsilon_counts_as_in_sync():
    o = order(refunded_total=19.995, payments=[payment(refunds=[{"amount": 20.0, "created_at": "2026-07-02T00:00:00Z"}])])
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is False
    assert result["reason"] == "in_sync"


def test_no_payment_collections_is_in_sync_when_order_shows_zero():
    o = {"id": "order_2", "summary": {"paid_total": 0, "refunded_total": 0, "transaction_total": 0, "accounting_total": 0}, "payment_collections": []}
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is False
    assert result["ledgerRefundedTotal"] == 0


def test_missing_summary_defaults_order_refunded_total_to_zero():
    o = {"id": "order_3", "payment_collections": [{"status": "authorized", "payments": [payment(refunds=[{"amount": 12.0, "created_at": "2026-07-02T00:00:00Z"}])]}]}
    result = decide_refund_reconciliation(o)
    assert result["needsSync"] is True
    assert result["reason"] == "refund_not_reflected"
    assert result["ledgerRefundedTotal"] == 12.0
