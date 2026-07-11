from fix_draft_order_payment import decide_draft_order_payment_action


def order(**over):
    base = {
        "isDraftOrder": True,
        "status": "pending",
        "hasCartId": False,
        "paymentCollections": [],
        "pendingDifference": 5000,
    }
    base.update(over)
    return base


def test_flags_stuck_when_no_collection_and_amount_pending():
    assert decide_draft_order_payment_action(order()) == "FLAG_STUCK_NO_PAYMENT"


def test_ok_when_not_a_draft_order():
    assert decide_draft_order_payment_action(order(isDraftOrder=False)) == "OK"


def test_ok_when_completed():
    assert decide_draft_order_payment_action(order(status="completed")) == "OK"


def test_ok_when_payment_collection_already_exists():
    o = order(paymentCollections=[{"id": "paycol_1", "status": "not_paid"}])
    assert decide_draft_order_payment_action(o) == "OK"


def test_ok_when_nothing_pending():
    assert decide_draft_order_payment_action(order(pendingDifference=0)) == "OK"


def test_needs_order_payment_collection_when_cart_id_present():
    o = order(hasCartId=True)
    assert decide_draft_order_payment_action(o) == "NEEDS_ORDER_PAYMENT_COLLECTION"


def test_flag_stuck_takes_priority_over_a_false_missing_cart_read():
    # Draft orders never have a real cart_id in practice, so this is the
    # branch that actually fires for real draft orders.
    o = order(hasCartId=False, pendingDifference=125.5)
    assert decide_draft_order_payment_action(o) == "FLAG_STUCK_NO_PAYMENT"


def test_ok_when_negative_pending_difference():
    o = order(pendingDifference=-10)
    assert decide_draft_order_payment_action(o) == "OK"
