from audit_promotion_rules import rule_matches_cart, build_cart_context, audit_promotion

CONTEXT = {
    "currency_code": "eur",
    "region": {"id": "reg_eu"},
    "region_id": "reg_eu",
    "customer": {"groups": [{"id": "pcgrp_vip"}]},
    "items": {"product": {"id": ["prod_1", "prod_2"]}},
}


def rule(**over):
    base = {"id": "prule_1", "attribute": "currency_code", "operator": "eq", "values": ["eur"]}
    base.update(over)
    return base


def test_eq_matches_when_value_present():
    assert rule_matches_cart(rule(), CONTEXT) is True


def test_eq_fails_on_currency_mismatch():
    assert rule_matches_cart(rule(values=["usd"]), CONTEXT) is False


def test_in_matches_any_of_multiple_values():
    r = rule(attribute="customer.groups.id", operator="in", values=["pcgrp_vip", "pcgrp_wholesale"])
    assert rule_matches_cart(r, CONTEXT) is True


def test_wrong_attribute_path_never_matches():
    r = rule(attribute="customer_group_id", operator="eq", values=["pcgrp_vip"])
    assert rule_matches_cart(r, CONTEXT) is False


def test_ne_true_when_no_intersection():
    r = rule(attribute="currency_code", operator="ne", values=["usd"])
    assert rule_matches_cart(r, CONTEXT) is True


def test_target_rule_deleted_product_never_matches():
    r = rule(attribute="items.product.id", operator="in", values=["prod_deleted"])
    assert rule_matches_cart(r, CONTEXT) is False


def test_target_rule_matches_existing_cart_item():
    r = rule(attribute="items.product.id", operator="in", values=["prod_1"])
    assert rule_matches_cart(r, CONTEXT) is True


def test_empty_values_never_matches():
    assert rule_matches_cart(rule(values=[]), CONTEXT) is False


def test_unresolved_path_returns_false_not_throws():
    r = rule(attribute="does.not.exist", operator="eq", values=["x"])
    assert rule_matches_cart(r, CONTEXT) is False


def test_gte_numeric_comparison():
    ctx = {**CONTEXT, "item_total": 100}
    r = rule(attribute="item_total", operator="gte", values=[50])
    assert rule_matches_cart(r, ctx) is True
    assert rule_matches_cart(rule(attribute="item_total", operator="gte", values=[150]), ctx) is False


def test_audit_flags_target_rule_on_deleted_product():
    promotion = {
        "id": "promo_1",
        "status": "active",
        "rules": [],
        "application_method": {"target_rules": [rule(attribute="items.product.id", operator="in", values=["prod_deleted"])]},
    }
    reports = audit_promotion(promotion, CONTEXT)
    assert len(reports) == 1
    assert "target rule" in reports[0]["reason"]


def test_audit_reports_nothing_when_all_rules_match():
    promotion = {
        "id": "promo_2",
        "status": "active",
        "rules": [rule()],
        "application_method": {"target_rules": [rule(attribute="items.product.id", operator="in", values=["prod_1"])]},
    }
    assert audit_promotion(promotion, CONTEXT) == []


def test_audit_flags_inactive_status():
    promotion = {"id": "promo_3", "status": "draft", "rules": [], "application_method": {}}
    reports = audit_promotion(promotion, CONTEXT)
    assert len(reports) == 1
    assert "not active" in reports[0]["reason"]


def test_build_cart_context_shapes_product_ids():
    cart = {"currency_code": "eur", "region_id": "reg_eu", "items": [{"product_id": "prod_1"}, {"product_id": "prod_2"}]}
    ctx = build_cart_context(cart, ["pcgrp_vip"])
    assert ctx["items"]["product"]["id"] == ["prod_1", "prod_2"]
    assert ctx["customer"]["groups"] == [{"id": "pcgrp_vip"}]
