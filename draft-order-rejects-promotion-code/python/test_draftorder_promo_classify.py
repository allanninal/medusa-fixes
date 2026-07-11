from fix_draft_order_promo_code import classify_promo_rejection


def draft_order(**over):
    base = {
        "status": "draft",
        "is_draft_order": True,
        "order_change": {"status": "pending", "canceled_at": None, "confirmed_at": None, "declined_at": None},
    }
    base.update(over)
    return base


def promo(**over):
    base = {"code": "SAVE10", "status": "active"}
    base.update(over)
    return base


def test_ok_when_edit_session_active_and_promo_active():
    result = classify_promo_rejection(draft_order(), [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "ok"}]


def test_no_active_edit_session_when_order_change_missing():
    order = draft_order(order_change=None)
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "no_active_edit_session"}]


def test_edit_session_inactive_when_confirmed():
    order = draft_order(order_change={"status": "confirmed", "canceled_at": None, "confirmed_at": "2026-07-01T00:00:00Z", "declined_at": None})
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "edit_session_inactive"}]


def test_edit_session_inactive_when_canceled():
    order = draft_order(order_change={"status": "canceled", "canceled_at": "2026-07-01T00:00:00Z", "confirmed_at": None, "declined_at": None})
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "edit_session_inactive"}]


def test_edit_session_inactive_when_declined():
    order = draft_order(order_change={"status": "declined", "canceled_at": None, "confirmed_at": None, "declined_at": "2026-07-01T00:00:00Z"})
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "edit_session_inactive"}]


def test_not_draft_order_when_status_not_draft_and_flag_false():
    order = draft_order(status="completed", is_draft_order=False)
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "not_draft_order"}]


def test_code_not_found_when_promotion_missing():
    result = classify_promo_rejection(draft_order(), [], ["MISSING10"])
    assert result == [{"code": "MISSING10", "reason": "code_not_found"}]


def test_code_not_active_when_promotion_status_draft():
    result = classify_promo_rejection(draft_order(), [promo(status="draft")], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "code_not_active"}]


def test_multiple_codes_classified_independently():
    order = draft_order()
    promotions = [promo(code="SAVE10", status="active"), promo(code="OFF20", status="draft")]
    result = classify_promo_rejection(order, promotions, ["SAVE10", "OFF20", "MISSING"])
    assert result == [
        {"code": "SAVE10", "reason": "ok"},
        {"code": "OFF20", "reason": "code_not_active"},
        {"code": "MISSING", "reason": "code_not_found"},
    ]


def test_no_active_edit_session_checked_before_code_lookup():
    order = draft_order(order_change=None)
    result = classify_promo_rejection(order, [], ["ANY"])
    assert result == [{"code": "ANY", "reason": "no_active_edit_session"}]


def test_not_draft_order_takes_priority_over_missing_order_change():
    order = draft_order(status="completed", is_draft_order=False, order_change=None)
    result = classify_promo_rejection(order, [promo()], ["SAVE10"])
    assert result == [{"code": "SAVE10", "reason": "not_draft_order"}]
