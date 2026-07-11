from reconcile_orphaned_captures import decide_reconciliation

GRACE_MS = 10 * 60 * 1000
NOW_MS = 1_800_000_000_000


def call(**over):
    base = dict(
        stripe_payment_intent_id="pi_123",
        stripe_status="succeeded",
        captured_at_ms=NOW_MS - GRACE_MS * 2,
        now_ms=NOW_MS,
        grace_ms=GRACE_MS,
        medusa_payment_data_ids=[],
        cart_completed_at=None,
        cart_has_order_id=False,
    )
    base.update(over)
    return decide_reconciliation(**base)


def test_orphaned_when_captured_unmatched_and_cart_incomplete():
    assert call() == "orphaned_capture_needs_manual_complete"


def test_already_reconciled_when_matched_and_cart_completed():
    result = call(medusa_payment_data_ids=["pi_123"], cart_completed_at="2026-07-10T00:00:00Z")
    assert result == "already_reconciled"


def test_already_reconciled_when_matched_and_has_order():
    result = call(medusa_payment_data_ids=["pi_123"], cart_has_order_id=True)
    assert result == "already_reconciled"


def test_ok_when_stripe_status_not_succeeded():
    assert call(stripe_status="processing") == "ok"


def test_too_recent_within_grace_window():
    result = call(captured_at_ms=NOW_MS - 1000)
    assert result == "too_recent"


def test_ok_when_matched_but_cart_still_incomplete():
    # matched in Medusa payments, but the cart genuinely has no completed_at/order.
    # not orphaned, since the flag only fires when the PI is unmatched.
    result = call(medusa_payment_data_ids=["pi_123"])
    assert result == "ok"


def test_exactly_at_grace_boundary_is_flagged():
    result = call(captured_at_ms=NOW_MS - GRACE_MS)
    assert result == "orphaned_capture_needs_manual_complete"


def test_not_flagged_when_cancelled():
    assert call(stripe_status="canceled") == "ok"


def test_not_flagged_when_requires_capture():
    assert call(stripe_status="requires_capture") == "ok"
