from find_suppressed_default_price import is_default_price_wrongly_suppressed, rules_match


def test_not_suppressed_when_not_from_price_list():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=1000,
        is_calculated_price_from_price_list=False,
        price_list_rules={},
        request_context={"customer_group_ids": []},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is False
    assert result["reason"] == "none"


def test_not_suppressed_when_no_default_to_compare():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=1000,
        is_calculated_price_from_price_list=True,
        price_list_rules={},
        request_context={"customer_group_ids": []},
        default_amount_for_currency=None,
    )
    assert result["suppressed"] is False
    assert result["reason"] == "none"


def test_suppressed_when_rules_do_not_match_context():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=900,
        is_calculated_price_from_price_list=True,
        price_list_rules={"customer_group_id": ["cusgrp_vip"]},
        request_context={"customer_group_ids": ["cusgrp_general"]},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is True
    assert result["reason"] == "rules_mismatch"


def test_suppressed_when_price_list_amount_higher_than_default():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=1500,
        is_calculated_price_from_price_list=True,
        price_list_rules={},
        request_context={"customer_group_ids": []},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is True
    assert result["reason"] == "higher_than_default"


def test_not_suppressed_when_rules_match_and_price_is_lower():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=900,
        is_calculated_price_from_price_list=True,
        price_list_rules={"customer_group_id": ["cusgrp_vip"]},
        request_context={"customer_group_ids": ["cusgrp_vip"]},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is False
    assert result["reason"] == "none"


def test_not_suppressed_when_price_list_amount_equal_to_default():
    result = is_default_price_wrongly_suppressed(
        calculated_amount=1200,
        is_calculated_price_from_price_list=True,
        price_list_rules={},
        request_context={"customer_group_ids": []},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is False
    assert result["reason"] == "none"


def test_rules_mismatch_takes_priority_over_amount_comparison():
    # Even when the price list price is cheaper, an unmatched rule context
    # still means it should not have applied to this shopper at all.
    result = is_default_price_wrongly_suppressed(
        calculated_amount=500,
        is_calculated_price_from_price_list=True,
        price_list_rules={"customer_group_id": ["cusgrp_vip"]},
        request_context={"customer_group_ids": ["cusgrp_general"]},
        default_amount_for_currency=1200,
    )
    assert result["suppressed"] is True
    assert result["reason"] == "rules_mismatch"


def test_rules_match_with_no_rules_is_always_true():
    assert rules_match({}, {"customer_group_ids": []}) is True


def test_rules_match_detects_intersection():
    assert rules_match({"customer_group_id": ["a", "b"]}, {"customer_group_ids": ["b"]}) is True
    assert rules_match({"customer_group_id": ["a", "b"]}, {"customer_group_ids": ["c"]}) is False


def test_rules_match_ignores_unknown_rule_keys():
    # Unrecognized rule keys are not evaluated, so they should not block a match.
    assert rules_match({"region_id": ["reg_1"]}, {"customer_group_ids": []}) is True
