from find_channel_leaks import is_promotion_allowed_for_channel, find_leaks


def rule(**over):
    base = {"attribute": "sales_channel_id", "operator": "eq", "values": ["sc_web"]}
    base.update(over)
    return base


def test_no_channel_rules_means_allowed_anywhere():
    assert is_promotion_allowed_for_channel([], "sc_pos") is True


def test_eq_allows_matching_channel():
    assert is_promotion_allowed_for_channel([rule()], "sc_web") is True


def test_eq_blocks_other_channel():
    assert is_promotion_allowed_for_channel([rule()], "sc_pos") is False


def test_in_allows_any_listed_channel():
    r = rule(operator="in", values=["sc_web", "sc_wholesale"])
    assert is_promotion_allowed_for_channel([r], "sc_wholesale") is True


def test_ne_blocks_the_excluded_channel():
    r = rule(operator="ne", values=["sc_pos"])
    assert is_promotion_allowed_for_channel([r], "sc_pos") is False


def test_nin_allows_channel_not_in_list():
    r = rule(operator="nin", values=["sc_pos"])
    assert is_promotion_allowed_for_channel([r], "sc_web") is True


def test_missing_cart_channel_fails_closed():
    assert is_promotion_allowed_for_channel([rule()], None) is False


def test_unknown_operator_fails_closed():
    assert is_promotion_allowed_for_channel([rule(operator="regex")], "sc_web") is False


def test_all_channel_rules_must_pass():
    rules = [rule(values=["sc_web"]), rule(operator="ne", values=["sc_web"])]
    assert is_promotion_allowed_for_channel(rules, "sc_web") is False


def test_find_leaks_flags_order_outside_promotion_channel():
    promotions = [{"id": "promo_1", "code": "WEB10", "rules": [rule()]}]
    orders = [{
        "id": "order_1",
        "sales_channel_id": "sc_pos",
        "total": 100,
        "currency_code": "usd",
        "promotions": [{"id": "promo_1", "code": "WEB10", "rules": [rule()]}],
    }]
    leaks = find_leaks(promotions, orders, {"sc_pos": "Point of Sale"})
    assert len(leaks) == 1
    assert leaks[0]["order_id"] == "order_1"
    assert leaks[0]["expected_sales_channel_ids"] == ["sc_web"]


def test_find_leaks_ignores_orders_in_the_right_channel():
    promotions = [{"id": "promo_1", "code": "WEB10", "rules": [rule()]}]
    orders = [{
        "id": "order_2",
        "sales_channel_id": "sc_web",
        "total": 50,
        "currency_code": "usd",
        "promotions": [{"id": "promo_1", "code": "WEB10", "rules": [rule()]}],
    }]
    assert find_leaks(promotions, orders, {}) == []


def test_find_leaks_ignores_promotions_without_channel_rules():
    promotions = [{"id": "promo_2", "code": "SALE5", "rules": []}]
    orders = [{
        "id": "order_3",
        "sales_channel_id": "sc_pos",
        "total": 20,
        "currency_code": "usd",
        "promotions": [{"id": "promo_2", "code": "SALE5", "rules": []}],
    }]
    assert find_leaks(promotions, orders, {}) == []
