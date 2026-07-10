from find_variant_options_mismatch import find_incomplete_variants, normalize_variant_options


def product(**over):
    base = {
        "id": "prod_1",
        "options": [
            {"title": "Color", "values": [{"value": "Red"}, {"value": "Blue"}]},
            {"title": "Size", "values": [{"value": "S"}, {"value": "M"}]},
        ],
        "variants": [],
    }
    base.update(over)
    return base


def variant(**over):
    base = {"id": "variant_1", "title": "Red / S", "options": {"Color": "Red", "Size": "S"}}
    base.update(over)
    return base


def test_complete_variant_is_not_flagged():
    p = product(variants=[variant()])
    assert find_incomplete_variants(p) == []


def test_missing_title_is_flagged():
    v = variant(options={"Color": "Red"})
    result = find_incomplete_variants(product(variants=[v]))
    assert len(result) == 1
    assert result[0]["missing_titles"] == ["Size"]
    assert result[0]["extra_titles"] == []
    assert result[0]["invalid_values"] == []


def test_extra_title_is_flagged():
    v = variant(options={"Color": "Red", "Size": "S", "Material": "Cotton"})
    result = find_incomplete_variants(product(variants=[v]))
    assert result[0]["extra_titles"] == ["Material"]


def test_invalid_value_is_flagged():
    v = variant(options={"Color": "Green", "Size": "S"})
    result = find_incomplete_variants(product(variants=[v]))
    assert result[0]["invalid_values"] == [{"title": "Color", "value": "Green"}]


def test_multiple_variants_only_flags_the_bad_one():
    good = variant(id="variant_ok", options={"Color": "Blue", "Size": "M"})
    bad = variant(id="variant_bad", options={"Color": "Red"})
    result = find_incomplete_variants(product(variants=[good, bad]))
    assert len(result) == 1
    assert result[0]["variant_id"] == "variant_bad"


def test_normalize_variant_options_handles_expanded_admin_shape():
    v = {
        "id": "variant_2",
        "options": [
            {"option": {"title": "Color"}, "value": "Red"},
            {"option": {"title": "Size"}, "value": "S"},
        ],
    }
    assert normalize_variant_options(v) == {"Color": "Red", "Size": "S"}


def test_normalize_variant_options_handles_flat_map():
    v = {"id": "variant_3", "options": {"Color": "Blue", "Size": "M"}}
    assert normalize_variant_options(v) == {"Color": "Blue", "Size": "M"}


def test_product_with_no_variants_reports_nothing():
    assert find_incomplete_variants(product(variants=[])) == []


def test_expanded_shape_flows_through_find_incomplete_variants():
    v = {
        "id": "variant_4",
        "title": "Green / L",
        "options": [
            {"option": {"title": "Color"}, "value": "Green"},
            {"option": {"title": "Size"}, "value": "L"},
        ],
    }
    result = find_incomplete_variants(product(variants=[v]))
    assert len(result) == 1
    assert {"title": "Color", "value": "Green"} in result[0]["invalid_values"]
    assert {"title": "Size", "value": "L"} in result[0]["invalid_values"]


def test_missing_and_extra_titles_together():
    v = variant(options={"Color": "Red", "Material": "Cotton"})
    result = find_incomplete_variants(product(variants=[v]))
    assert result[0]["missing_titles"] == ["Size"]
    assert result[0]["extra_titles"] == ["Material"]


def test_no_options_on_product_flags_any_variant_title_as_extra():
    p = product(options=[], variants=[variant(options={"Color": "Red"})])
    result = find_incomplete_variants(p)
    assert result[0]["missing_titles"] == []
    assert result[0]["extra_titles"] == ["Color"]
