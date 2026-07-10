from find_missing_region_prices import find_missing_region_prices


def variant(**over):
    base = {"id": "variant_1", "sku": "SKU-1", "prices": [{"currency_code": "usd"}, {"currency_code": "gbp"}]}
    base.update(over)
    return base


def region(**over):
    base = {"id": "reg_1", "name": "United States", "currency_code": "usd"}
    base.update(over)
    return base


def test_no_gaps_when_all_currencies_covered():
    regions = [region(), region(id="reg_2", name="United Kingdom", currency_code="gbp")]
    assert find_missing_region_prices([variant()], regions) == []


def test_gap_when_region_currency_missing():
    regions = [region(id="reg_3", name="Eurozone", currency_code="eur")]
    gaps = find_missing_region_prices([variant()], regions)
    assert len(gaps) == 1
    assert gaps[0]["region_name"] == "Eurozone"
    assert gaps[0]["missing_currency_code"] == "eur"
    assert gaps[0]["variant_id"] == "variant_1"


def test_gap_when_variant_has_no_prices_at_all():
    gaps = find_missing_region_prices([variant(prices=[])], [region()])
    assert len(gaps) == 1


def test_gap_when_prices_key_missing_entirely():
    v = {"id": "variant_2", "sku": "SKU-2"}
    gaps = find_missing_region_prices([v], [region()])
    assert len(gaps) == 1
    assert gaps[0]["variant_id"] == "variant_2"


def test_currency_match_is_case_insensitive():
    regions = [region(currency_code="USD")]
    assert find_missing_region_prices([variant()], regions) == []


def test_multiple_variants_and_regions_each_checked():
    variants = [variant(), variant(id="variant_2", sku="SKU-2", prices=[])]
    regions = [region(), region(id="reg_2", name="Eurozone", currency_code="eur")]
    gaps = find_missing_region_prices(variants, regions)
    # variant_1 is missing eur only, variant_2 is missing both usd and eur
    assert len(gaps) == 3


def test_empty_variants_returns_no_gaps():
    assert find_missing_region_prices([], [region()]) == []


def test_empty_regions_returns_no_gaps():
    assert find_missing_region_prices([variant()], []) == []
