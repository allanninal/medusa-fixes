from reconcile_payment_status import detect_payment_status_mismatch


def order(**over):
    base = {
        "id": "order_1",
        "payment_status": "captured",
        "summary": {"raw_paid_total": {"value": 5000}, "raw_transaction_total": {"value": 5000}},
        "payment_collections": [
            {
                "status": "captured",
                "payments": [
                    {"captured_at": "2026-07-01T00:00:00Z", "captures": [{"raw_amount": {"value": 5000}}]}
                ],
            }
        ],
    }
    base.update(over)
    return base


def test_no_mismatch_when_everything_agrees():
    result = detect_payment_status_mismatch(order())
    assert result == {"orderId": "order_1", "mismatched": False, "reason": None}


def test_mismatch_when_captured_but_status_not_paid():
    o = order(payment_status="not_paid")
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is True
    assert "payment_status is still not_paid" in result["reason"]


def test_mismatch_when_captured_but_paid_total_zero():
    o = order()
    o["summary"]["raw_paid_total"]["value"] = 0
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is True
    assert "raw_paid_total is 0" in result["reason"]


def test_mismatch_when_collection_status_stale():
    o = order()
    o["payment_collections"][0]["status"] = "awaiting"
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is True


def test_no_mismatch_when_nothing_captured():
    o = order(payment_status="not_paid")
    o["summary"]["raw_paid_total"]["value"] = 0
    o["payment_collections"][0]["payments"][0]["captures"] = []
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is False


def test_sums_captures_across_multiple_payment_collections():
    o = order()
    o["payment_collections"].append({
        "status": "captured",
        "payments": [
            {"captured_at": "2026-07-02T00:00:00Z", "captures": [{"raw_amount": {"value": 1500}}]}
        ],
    })
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is False


def test_mismatched_orderid_matches_input_order():
    o = order(id="order_42", payment_status="awaiting")
    result = detect_payment_status_mismatch(o)
    assert result["orderId"] == "order_42"
    assert result["mismatched"] is True


def test_no_mismatch_when_no_payment_collections():
    o = order(payment_collections=[])
    o["summary"]["raw_paid_total"]["value"] = 0
    o["payment_status"] = "not_paid"
    result = detect_payment_status_mismatch(o)
    assert result["mismatched"] is False
