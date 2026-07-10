from find_currency_mismatches import find_currency_mismatches

REGION = {"id": "reg_in", "currency_code": "inr"}


def variant_price(**over):
    base = {
        "variant_id": "variant_1",
        "product_id": "prod_1",
        "prices": [{"id": "price_1", "currency_code": "inr", "amount": 1499.0, "price_list_id": None}],
        "calculated_price": {"currency_code": "inr", "price_list_id": None},
    }
    base.update(over)
    return base


def test_no_finding_when_currencies_match():
    assert find_currency_mismatches(REGION, [variant_price()]) == []


def test_calculated_mismatch_when_resolved_currency_differs():
    vp = variant_price(calculated_price={"currency_code": "eur", "price_list_id": "plist_1"})
    findings = find_currency_mismatches(REGION, [vp])
    assert findings == [{
        "product_id": "prod_1",
        "variant_id": "variant_1",
        "region_id": "reg_in",
        "expected_currency": "inr",
        "shown_currency": "eur",
        "price_id": None,
        "price_list_id": "plist_1",
        "reason": "calculated_mismatch",
    }]


def test_missing_currency_row_when_no_row_matches_region():
    vp = variant_price(
        calculated_price=None,
        prices=[{"id": "price_2", "currency_code": "eur", "amount": 42.0, "price_list_id": None}],
    )
    findings = find_currency_mismatches(REGION, [vp])
    assert findings == [{
        "product_id": "prod_1",
        "variant_id": "variant_1",
        "region_id": "reg_in",
        "expected_currency": "inr",
        "shown_currency": "eur",
        "price_id": "price_2",
        "price_list_id": None,
        "reason": "missing_currency_row",
    }]


def test_missing_currency_row_with_no_prices_at_all():
    vp = variant_price(calculated_price=None, prices=[])
    findings = find_currency_mismatches(REGION, [vp])
    assert findings[0]["reason"] == "missing_currency_row"
    assert findings[0]["shown_currency"] is None
    assert findings[0]["price_id"] is None


def test_calculated_mismatch_takes_priority_over_row_check():
    vp = variant_price(
        calculated_price={"currency_code": "usd", "price_list_id": None},
        prices=[{"id": "price_3", "currency_code": "inr", "amount": 1499.0, "price_list_id": None}],
    )
    findings = find_currency_mismatches(REGION, [vp])
    assert len(findings) == 1
    assert findings[0]["reason"] == "calculated_mismatch"


def test_multiple_variants_only_flags_the_mismatched_one():
    ok_vp = variant_price(variant_id="variant_ok")
    bad_vp = variant_price(variant_id="variant_bad", calculated_price={"currency_code": "eur", "price_list_id": None})
    findings = find_currency_mismatches(REGION, [ok_vp, bad_vp])
    assert len(findings) == 1
    assert findings[0]["variant_id"] == "variant_bad"


def test_no_currency_row_and_no_calculated_price_still_flags_missing_row():
    vp = variant_price(calculated_price=None, prices=[{"id": "price_4", "currency_code": "usd", "amount": 10.0, "price_list_id": "plist_2"}])
    findings = find_currency_mismatches(REGION, [vp])
    assert findings[0]["reason"] == "missing_currency_row"
    assert findings[0]["price_list_id"] == "plist_2"
