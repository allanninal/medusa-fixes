from flag_over_budget_campaigns import is_campaign_over_budget, build_report


def test_unlimited_budget_is_never_over():
    result = is_campaign_over_budget({"type": "spend", "limit": None, "used": 999999})
    assert result == {"overBudget": False, "wouldExceedIfApplied": False, "overageAmount": 0}


def test_used_under_limit_is_not_over_budget():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 4000})
    assert result["overBudget"] is False
    assert result["overageAmount"] == 0


def test_used_equal_to_limit_counts_as_over_budget():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 5000})
    assert result["overBudget"] is True
    assert result["overageAmount"] == 0


def test_used_past_limit_reports_overage_amount():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 6600})
    assert result["overBudget"] is True
    assert result["overageAmount"] == 1600


def test_usage_type_limit_zero_is_immediately_over():
    result = is_campaign_over_budget({"type": "usage", "limit": 0, "used": 0})
    assert result["overBudget"] is True
    assert result["overageAmount"] == 0


def test_would_exceed_if_applied_true_when_pending_amount_pushes_past_limit():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 4800}, pending_amount=500)
    assert result["overBudget"] is False
    assert result["wouldExceedIfApplied"] is True


def test_would_exceed_if_applied_false_when_pending_amount_still_fits():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 4800}, pending_amount=100)
    assert result["wouldExceedIfApplied"] is False


def test_no_pending_amount_never_sets_would_exceed_if_applied():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": 4800})
    assert result["wouldExceedIfApplied"] is False


def test_negative_used_from_a_race_condition_is_not_over_budget():
    result = is_campaign_over_budget({"type": "spend", "limit": 5000, "used": -200})
    assert result["overBudget"] is False
    assert result["overageAmount"] == 0


def test_missing_used_key_defaults_to_zero():
    result = is_campaign_over_budget({"type": "spend", "limit": 100})
    assert result["overBudget"] is False
    assert result["overageAmount"] == 0


def test_build_report_shapes_expected_fields():
    campaign = {"id": "camp_1", "name": "Summer sale", "budget": {"type": "spend", "limit": 5000, "used": 6600}}
    decision = is_campaign_over_budget(campaign["budget"])
    promotions = [{"id": "promo_1"}, {"id": "promo_2"}]
    orders = [{"id": "order_1"}]
    report = build_report(campaign, decision, promotions, orders)
    assert report["campaign_id"] == "camp_1"
    assert report["overage_amount"] == 1600
    assert report["promotion_ids"] == ["promo_1", "promo_2"]
    assert report["order_ids"] == ["order_1"]
