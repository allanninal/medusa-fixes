from reconcile_skipped_compensation import classify_orphan


def order(**over):
    base = {
        "id": "order_1",
        "payment_status": "captured",
        "fulfillment_status": "not_fulfilled",
        "payments": [{"status": "captured"}],
        "fulfillments": [],
        "items": [{"id": "item_1", "quantity": 1}],
    }
    base.update(over)
    return base


CONTINUE_FAILED_STEP = [{"action": "captureStep.continueOnPermanentFailure", "handlerType": "invoke"}]
RESERVE_FAILED_STEP = [{"action": "reserveInventoryStep", "handlerType": "invoke"}]


def test_orphaned_payment_no_fulfillment_when_captured_and_unfulfilled():
    assert classify_orphan(order(), CONTINUE_FAILED_STEP) == "orphaned_payment_no_fulfillment"


def test_ok_when_no_failed_steps():
    assert classify_orphan(order(), []) == "ok"


def test_ok_when_fulfillment_exists():
    o = order(fulfillments=[{"id": "ful_1"}])
    assert classify_orphan(o, CONTINUE_FAILED_STEP) == "ok"


def test_ok_when_payment_not_captured():
    o = order(payment_status="not_paid", payments=[])
    assert classify_orphan(o, CONTINUE_FAILED_STEP) == "ok"


def test_orphaned_reservation_no_order_line_when_items_empty():
    o = order(items=[], payment_status="not_paid", payments=[])
    assert classify_orphan(o, RESERVE_FAILED_STEP) == "orphaned_reservation_no_order_line"


def test_ok_when_reservation_failed_but_items_still_present():
    assert classify_orphan(order(), RESERVE_FAILED_STEP) == "ok"


def test_ok_when_continue_on_failure_step_is_a_compensate_entry():
    step = [{"action": "captureStep.continueOnPermanentFailure", "handlerType": "compensate"}]
    assert classify_orphan(order(), step) == "ok"
