from reconcile_shipping_discount import (
    compute_expected_shipping_adjustment,
    evaluate_stale_adjustment,
)


def shipping_method(**over):
    base = {"id": "sm_1", "amount": 1079}
    base.update(over)
    return base


def promotion(**over):
    base = {
        "id": "promo_1",
        "code": "FREESHIP",
        "application_method": {"type": "percentage", "value": 100, "target_type": "shipping_methods"},
    }
    base.update(over)
    return base


def test_percentage_full_off_matches_current_amount():
    result = compute_expected_shipping_adjustment(shipping_method(), promotion())
    assert result["adjustment_amount"] == 1079


def test_percentage_partial_off():
    promo = promotion(application_method={"type": "percentage", "value": 50, "target_type": "shipping_methods"})
    result = compute_expected_shipping_adjustment(shipping_method(), promo)
    assert result["adjustment_amount"] == 539.5


def test_fixed_amount_capped_at_shipping_amount():
    promo = promotion(application_method={"type": "fixed", "value": 5000, "target_type": "shipping_methods"})
    result = compute_expected_shipping_adjustment(shipping_method(amount=1079), promo)
    assert result["adjustment_amount"] == 1079


def test_fixed_amount_below_shipping_amount():
    promo = promotion(application_method={"type": "fixed", "value": 300, "target_type": "shipping_methods"})
    result = compute_expected_shipping_adjustment(shipping_method(amount=1079), promo)
    assert result["adjustment_amount"] == 300


def test_non_shipping_target_returns_none():
    promo = promotion(application_method={"type": "percentage", "value": 100, "target_type": "items"})
    assert compute_expected_shipping_adjustment(shipping_method(), promo) is None


def test_stale_when_stored_amount_is_from_before_refresh():
    result = evaluate_stale_adjustment(shipping_method(), promotion(), 929)
    assert result["is_stale"] is True
    assert result["delta"] == 929 - 1079


def test_not_stale_when_stored_matches_expected():
    result = evaluate_stale_adjustment(shipping_method(), promotion(), 1079)
    assert result["is_stale"] is False
    assert result["delta"] == 0


def test_not_stale_within_tolerance():
    result = evaluate_stale_adjustment(shipping_method(), promotion(), 1079.005)
    assert result["is_stale"] is False


def test_none_when_promotion_not_shipping_targeted():
    promo = promotion(application_method={"type": "percentage", "value": 100, "target_type": "items"})
    assert evaluate_stale_adjustment(shipping_method(), promo, 929) is None
