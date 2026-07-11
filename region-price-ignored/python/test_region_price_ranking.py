from find_ignored_region_price import pick_winning_price, has_region_and_currency_only_pair


CONTEXT = {"region_id": "reg_eu", "currency_code": "eur"}


def currency_only(amount=1000, currency="eur"):
    return {"id": "price_currency_only", "amount": amount, "currency_code": currency, "rules": []}


def region_scoped(amount=800, region="reg_eu", currency="eur"):
    return {
        "id": "price_region",
        "amount": amount,
        "currency_code": currency,
        "rules": [{"attribute": "region_id", "value": region}],
    }


def region_and_currency(amount=800, region="reg_eu", currency="eur"):
    return {
        "id": "price_region_currency",
        "amount": amount,
        "currency_code": currency,
        "rules": [
            {"attribute": "region_id", "value": region},
            {"attribute": "currency_code", "value": currency},
        ],
    }


def test_region_plus_currency_price_outranks_currency_only():
    prices = [currency_only(), region_and_currency()]
    winner = pick_winning_price(prices, CONTEXT)
    assert winner == {"id": "price_region_currency", "amount": 800}


def test_region_only_price_still_outranks_currency_only_on_tie_break():
    prices = [currency_only(), region_scoped()]
    winner = pick_winning_price(prices, CONTEXT)
    assert winner == {"id": "price_region", "amount": 800}


def test_wrong_region_rule_is_excluded():
    prices = [currency_only(), region_scoped(region="reg_us")]
    winner = pick_winning_price(prices, CONTEXT)
    assert winner == {"id": "price_currency_only", "amount": 1000}


def test_wrong_currency_is_excluded_even_with_matching_region():
    prices = [region_scoped(currency="usd")]
    winner = pick_winning_price(prices, CONTEXT)
    assert winner is None


def test_no_candidates_returns_none():
    assert pick_winning_price([], CONTEXT) is None


def test_region_and_currency_beats_region_only_when_both_present():
    prices = [currency_only(), region_scoped(), region_and_currency()]
    winner = pick_winning_price(prices, CONTEXT)
    assert winner == {"id": "price_region_currency", "amount": 800}


def test_has_region_and_currency_only_pair_true_when_both_present():
    prices = [currency_only(), region_scoped()]
    assert has_region_and_currency_only_pair(prices, "reg_eu", "eur") is True


def test_has_region_and_currency_only_pair_false_when_only_one_present():
    prices = [currency_only()]
    assert has_region_and_currency_only_pair(prices, "reg_eu", "eur") is False


def test_has_region_and_currency_only_pair_false_when_wrong_region():
    prices = [currency_only(), region_scoped(region="reg_us")]
    assert has_region_and_currency_only_pair(prices, "reg_eu", "eur") is False
