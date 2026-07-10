from datetime import datetime

from flag_sla_breached_orders import evaluate_order_sla

NOW_MS = datetime.fromisoformat("2026-07-10T00:00:00+00:00").timestamp() * 1000


def order(**over):
    base = {
        "status": "completed",
        "payment_status": "captured",
        "fulfillment_status": "not_fulfilled",
        "fulfillments": [],
        "created_at": "2026-07-06T00:00:00Z",  # 96h before NOW_MS
        "metadata": {},
    }
    base.update(over)
    return base


def test_breached_when_paid_unfulfilled_and_past_sla():
    result = evaluate_order_sla(order(), NOW_MS, 48)
    assert result["breached"] is True
    assert result["already_flagged"] is False
    assert round(result["age_hours"]) == 96


def test_not_breached_when_within_sla():
    o = order(created_at="2026-07-09T12:00:00Z")  # 12h before NOW_MS
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_not_breached_when_not_paid():
    o = order(payment_status="not_paid")
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_not_breached_when_paid_via_payment_collections():
    o = order(payment_status=None, payment_collections=[{"status": "captured"}])
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is True


def test_not_breached_when_a_payment_collection_is_not_captured():
    o = order(payment_status=None, payment_collections=[{"status": "captured"}, {"status": "not_paid"}])
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_not_breached_when_already_fulfilled():
    o = order(fulfillment_status="fulfilled", fulfillments=[{"id": "ful_1"}])
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_breached_when_partially_fulfilled_past_sla():
    o = order(fulfillment_status="partially_fulfilled", fulfillments=[{"id": "ful_1"}])
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is True


def test_breached_when_status_not_fulfilled_but_fulfillments_array_nonempty_is_ignored():
    # not_fulfilled status alone is enough, even if fulfillments happens to be non-empty
    o = order(fulfillment_status="not_fulfilled", fulfillments=[{"id": "ful_stale"}])
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is True


def test_not_breached_when_canceled():
    o = order(status="canceled")
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_not_breached_when_already_flagged():
    o = order(metadata={"sla_flagged": True})
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False
    assert result["already_flagged"] is True


def test_exactly_at_sla_boundary_is_not_breached():
    o = order(created_at="2026-07-08T00:00:00Z")  # exactly 48h before NOW_MS
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False


def test_missing_created_at_is_not_breached():
    o = order(created_at=None)
    result = evaluate_order_sla(o, NOW_MS, 48)
    assert result["breached"] is False
