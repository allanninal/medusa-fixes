from flag_edit_cancels_payment import classify_order_payment_edit_state


def order(**over):
    base = {
        "id": "order_1",
        "payment_status": "not_paid",
        "summary": {"raw_difference_due": 5000},
        "payment_collections": [
            {"id": "paycol_1", "status": "canceled", "amount": 5000},
        ],
    }
    base.update(over)
    return base


def test_blocked_when_only_canceled_collection_and_amount_due():
    result = classify_order_payment_edit_state(order())
    assert result["blocked"] is True
    assert result["reason"] == "canceled_collection_blocks_capture"
    assert result["canceledCollectionId"] == "paycol_1"
    assert result["amountDue"] == 5000


def test_not_blocked_when_healthy_paid_order():
    o = order(payment_status="captured", summary={"raw_difference_due": 0})
    result = classify_order_payment_edit_state(o)
    assert result == {"blocked": False, "reason": None, "canceledCollectionId": None, "amountDue": 0}


def test_not_blocked_when_an_active_collection_exists():
    o = order(payment_collections=[
        {"id": "paycol_1", "status": "canceled", "amount": 5000},
        {"id": "paycol_2", "status": "not_paid", "amount": 5000},
    ])
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is False


def test_blocked_with_only_canceled_collection_and_outstanding_balance():
    o = order(payment_collections=[{"id": "paycol_9", "status": "canceled", "amount": 12000}],
              summary={"raw_difference_due": 12000})
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is True
    assert result["canceledCollectionId"] == "paycol_9"
    assert result["amountDue"] == 12000


def test_not_blocked_when_fully_refunded_or_canceled_with_no_amount_due():
    o = order(summary={"raw_difference_due": 0})
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is False


def test_not_blocked_when_payment_status_is_not_not_paid():
    o = order(payment_status="awaiting")
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is False


def test_falls_back_to_summing_uncaptured_collections_when_summary_missing():
    o = order(summary={}, payment_collections=[
        {"id": "paycol_1", "status": "canceled", "amount": 3000},
    ])
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is True
    assert result["amountDue"] == 3000


def test_not_blocked_when_amount_due_is_zero_even_with_canceled_collection():
    o = order(summary={"raw_difference_due": 0})
    result = classify_order_payment_edit_state(o)
    assert result["blocked"] is False
    assert result["amountDue"] == 0
