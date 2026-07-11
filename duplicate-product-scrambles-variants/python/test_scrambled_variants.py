from diff_variant_options import diff_variant_option_signatures


def variant(sku, size, color):
    return {"sku": sku, "options": [{"title": "Size", "value": size}, {"title": "Color", "value": color}]}


def test_identical_order_has_no_mismatches():
    source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")]
    dup = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")]
    assert diff_variant_option_signatures(source, dup) == []


def test_shuffled_option_order_within_a_variant_is_not_a_mismatch():
    source = [{"sku": "SKU-1", "options": [{"title": "Size", "value": "Small"}, {"title": "Color", "value": "Red"}]}]
    dup = [{"sku": "SKU-1", "options": [{"title": "Color", "value": "Red"}, {"title": "Size", "value": "Small"}]}]
    assert diff_variant_option_signatures(source, dup) == []


def test_scrambled_value_assignment_is_flagged():
    source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")]
    dup = [variant("SKU-1", "Large", "Blue"), variant("SKU-2", "Small", "Red")]
    mismatches = diff_variant_option_signatures(source, dup)
    assert len(mismatches) == 2
    skus = {m["sku"] for m in mismatches}
    assert skus == {"SKU-1", "SKU-2"}


def test_mismatch_reports_expected_and_actual():
    source = [variant("SKU-1", "Small", "Red")]
    dup = [variant("SKU-1", "Large", "Red")]
    mismatches = diff_variant_option_signatures(source, dup)
    assert mismatches == [{"sku": "SKU-1", "expected": "Color:Red|Size:Small", "actual": "Color:Red|Size:Large"}]


def test_collision_where_two_duplicate_variants_share_a_signature():
    source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")]
    dup = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Small", "Red")]
    mismatches = diff_variant_option_signatures(source, dup)
    assert len(mismatches) == 1
    assert mismatches[0]["sku"] == "SKU-2"
    assert mismatches[0]["actual"] == mismatches[0]["expected"].replace("Large", "Small").replace("Blue", "Red")


def test_falls_back_to_index_when_skus_are_missing():
    source = [{"sku": None, "options": [{"title": "Size", "value": "Small"}]},
              {"sku": None, "options": [{"title": "Size", "value": "Large"}]}]
    dup = [{"sku": None, "options": [{"title": "Size", "value": "Large"}]},
           {"sku": None, "options": [{"title": "Size", "value": "Small"}]}]
    mismatches = diff_variant_option_signatures(source, dup)
    assert len(mismatches) == 2


def test_falls_back_to_index_when_skus_collide():
    source = [variant("SAME", "Small", "Red"), variant("SAME", "Large", "Blue")]
    dup = [variant("SAME", "Large", "Blue"), variant("SAME", "Small", "Red")]
    mismatches = diff_variant_option_signatures(source, dup)
    assert len(mismatches) == 2


def test_no_mismatches_when_products_have_no_variants():
    assert diff_variant_option_signatures([], []) == []
