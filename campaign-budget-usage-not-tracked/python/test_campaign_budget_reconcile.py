from reconcile_campaign_budget import reconcile_campaign_budget_usage, is_buyget_budget_campaign


def campaign(**over):
    base = {"id": "camp_1", "budget": {"type": "usage", "limit": 100, "used": 0}}
    base.update(over)
    return base


def redemption(**over):
    base = {"orderId": "order_1", "promotionId": "promo_1", "discountTotal": 10.0}
    base.update(over)
    return base


def test_usage_budget_counts_redemptions():
    redemptions = [redemption(orderId="order_1"), redemption(orderId="order_2")]
    result = reconcile_campaign_budget_usage(campaign(), redemptions)
    assert result["recomputedUsed"] == 2
    assert result["needsSync"] is True
    assert result["overBudget"] is False


def test_spend_budget_sums_discount_totals():
    c = campaign(budget={"type": "spend", "limit": 100, "used": 0})
    redemptions = [redemption(discountTotal=30.0), redemption(discountTotal=45.0)]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["recomputedUsed"] == 75.0
    assert result["needsSync"] is True
    assert result["overBudget"] is False


def test_no_sync_needed_when_stored_matches_recomputed():
    c = campaign(budget={"type": "usage", "limit": 100, "used": 2})
    redemptions = [redemption(orderId="order_1"), redemption(orderId="order_2")]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["needsSync"] is False


def test_over_budget_when_recomputed_exceeds_limit():
    c = campaign(budget={"type": "usage", "limit": 2, "used": 0})
    redemptions = [redemption(orderId=f"order_{i}") for i in range(5)]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["recomputedUsed"] == 5
    assert result["overBudget"] is True


def test_exactly_at_limit_is_not_over_budget():
    c = campaign(budget={"type": "usage", "limit": 3, "used": 0})
    redemptions = [redemption(orderId=f"order_{i}") for i in range(3)]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["overBudget"] is False


def test_zero_limit_means_unlimited_never_over_budget():
    c = campaign(budget={"type": "usage", "limit": 0, "used": 0})
    redemptions = [redemption(orderId=f"order_{i}") for i in range(50)]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["overBudget"] is False


def test_no_redemptions_recomputes_to_zero():
    result = reconcile_campaign_budget_usage(campaign(), [])
    assert result["recomputedUsed"] == 0
    assert result["needsSync"] is False


def test_spend_budget_over_limit_from_summed_adjustments():
    c = campaign(budget={"type": "spend", "limit": 50.0, "used": 0})
    redemptions = [redemption(discountTotal=20.0), redemption(discountTotal=40.0)]
    result = reconcile_campaign_budget_usage(c, redemptions)
    assert result["recomputedUsed"] == 60.0
    assert result["overBudget"] is True


def test_is_buyget_budget_campaign_requires_limit_and_buyget_type():
    c = {"budget": {"limit": 50, "used": 0}, "promotions": [{"id": "promo_1", "type": "buyget"}]}
    assert is_buyget_budget_campaign(c) is True


def test_is_buyget_budget_campaign_false_without_limit():
    c = {"budget": {"limit": 0, "used": 0}, "promotions": [{"id": "promo_1", "type": "buyget"}]}
    assert is_buyget_budget_campaign(c) is False


def test_is_buyget_budget_campaign_false_without_buyget_promotion():
    c = {"budget": {"limit": 50, "used": 0}, "promotions": [{"id": "promo_1", "type": "standard"}]}
    assert is_buyget_budget_campaign(c) is False
