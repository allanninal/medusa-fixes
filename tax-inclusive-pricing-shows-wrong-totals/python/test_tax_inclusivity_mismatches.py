from find_tax_inclusivity_mismatches import find_tax_inclusivity_mismatches

REGION_PREF_TRUE = {"attribute": "region_id", "value": "reg_1", "is_tax_inclusive": True}
CURRENCY_PREF_FALSE = {"attribute": "currency_code", "value": "eur", "is_tax_inclusive": False}


def context(**over):
    base = {"source_type": "shipping_option", "source_id": "so_1", "region_id": "reg_1", "currency_code": "eur"}
    base.update(over)
    return base


def test_no_mismatch_when_region_and_currency_prefs_agree():
    agree_pref = {"attribute": "currency_code", "value": "eur", "is_tax_inclusive": True}
    findings = find_tax_inclusivity_mismatches([REGION_PREF_TRUE, agree_pref], [context()])
    assert findings == []


def test_conflict_when_region_and_currency_prefs_disagree():
    findings = find_tax_inclusivity_mismatches([REGION_PREF_TRUE, CURRENCY_PREF_FALSE], [context()])
    assert len(findings) == 1
    assert findings[0]["reason"] == "region/currency preference conflict"
    assert findings[0]["region_pref"] is True
    assert findings[0]["currency_pref"] is False


def test_no_preference_configured_at_all():
    findings = find_tax_inclusivity_mismatches([], [context(region_id="reg_unknown", currency_code="jpy")])
    assert len(findings) == 1
    assert findings[0]["reason"] == "no preference configured, defaults may drift"
    assert findings[0]["region_pref"] is None
    assert findings[0]["currency_pref"] is None


def test_no_mismatch_when_only_one_preference_exists_and_no_conflict_possible():
    findings = find_tax_inclusivity_mismatches([REGION_PREF_TRUE], [context(currency_code="usd")])
    assert findings == []


def test_source_type_and_id_are_preserved_on_the_finding():
    findings = find_tax_inclusivity_mismatches(
        [REGION_PREF_TRUE, CURRENCY_PREF_FALSE],
        [context(source_type="price_list", source_id="plist_9")],
    )
    assert findings[0]["source_type"] == "price_list"
    assert findings[0]["source_id"] == "plist_9"


def test_multiple_contexts_only_flags_the_mismatched_one():
    ok_pref = {"attribute": "region_id", "value": "reg_ok", "is_tax_inclusive": True}
    ok_ctx = context(source_id="so_ok", region_id="reg_ok", currency_code="usd")
    bad_ctx = context(source_id="so_bad")
    findings = find_tax_inclusivity_mismatches([REGION_PREF_TRUE, CURRENCY_PREF_FALSE, ok_pref], [ok_ctx, bad_ctx])
    assert len(findings) == 1
    assert findings[0]["source_id"] == "so_bad"
