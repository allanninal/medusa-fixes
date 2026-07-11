from flag_stuck_fulfillment import decide_fulfillment_repair


def order(fulfillment_status="delivered", refunded_total=0.0, items=None, returns=None):
    return {
        "id": "order_1",
        "fulfillment_status": fulfillment_status,
        "summary": {"refunded_total": refunded_total},
        "items": items or [{"id": "item_1", "quantity": 2, "unit_price": 50.0}],
        "returns": returns or [],
    }


def received(status="received", lines=None):
    return {"status": status, "items": lines or [{"item_id": "item_1", "quantity": 2}]}


def test_stuck_delivered_when_fully_returned_and_refunded():
    o = order(refunded_total=100.0, returns=[received()])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is True
    assert result["reason"] == "stuck_delivered"
    assert result["receivedQty"] == 2
    assert result["returnedValue"] == 100.0


def test_not_returned_when_no_returns_present():
    o = order(refunded_total=0.0, returns=[])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is False
    assert result["reason"] == "not_returned"


def test_in_progress_when_return_partially_received():
    o = order(refunded_total=50.0, returns=[received(lines=[{"item_id": "item_1", "quantity": 1}])])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is False
    assert result["reason"] == "in_progress"


def test_in_progress_when_received_but_refund_not_issued_yet():
    o = order(refunded_total=0.0, returns=[received()])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is False
    assert result["reason"] == "in_progress"


def test_ignores_returns_not_yet_received():
    o = order(refunded_total=0.0, returns=[received(status="requested")])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is False
    assert result["reason"] == "not_returned"


def test_not_stuck_when_fulfillment_status_already_updated():
    o = order(fulfillment_status="canceled", refunded_total=100.0, returns=[received()])
    result = decide_fulfillment_repair(o)
    assert result["isStuck"] is False
    assert result["reason"] == "not_returned"


def test_sums_across_multiple_returns_and_items():
    items = [
        {"id": "item_1", "quantity": 2, "unit_price": 30.0},
        {"id": "item_2", "quantity": 1, "unit_price": 40.0},
    ]
    returns = [
        received(lines=[{"item_id": "item_1", "quantity": 2}]),
        received(lines=[{"item_id": "item_2", "quantity": 1}]),
    ]
    o = order(refunded_total=100.0, items=items, returns=returns)
    result = decide_fulfillment_repair(o)
    assert result["fulfilledQty"] == 3
    assert result["receivedQty"] == 3
    assert result["returnedValue"] == 100.0
    assert result["isStuck"] is True
