from find_barcode_conflicts import find_barcode_conflicts


def variant(**over):
    base = {"productId": "prod_1", "variantId": "variant_1", "barcode": None, "ean": None, "upc": None}
    base.update(over)
    return base


def test_no_conflicts_returns_empty_list():
    variants = [
        variant(productId="prod_1", variantId="variant_1", barcode="1111"),
        variant(productId="prod_2", variantId="variant_2", barcode="2222"),
    ]
    assert find_barcode_conflicts(variants) == []


def test_two_products_sharing_a_barcode_is_flagged():
    variants = [
        variant(productId="prod_1", variantId="variant_1", barcode="1111"),
        variant(productId="prod_2", variantId="variant_2", barcode="1111"),
    ]
    conflicts = find_barcode_conflicts(variants)
    assert len(conflicts) == 1
    assert conflicts[0]["field"] == "barcode"
    assert conflicts[0]["value"] == "1111"
    assert len(conflicts[0]["entries"]) == 2


def test_same_product_repeat_is_not_flagged():
    variants = [
        variant(productId="prod_1", variantId="variant_1", barcode="1111"),
        variant(productId="prod_1", variantId="variant_2", barcode="1111"),
    ]
    assert find_barcode_conflicts(variants) == []


def test_fields_are_checked_independently():
    variants = [
        variant(productId="prod_1", variantId="variant_1", ean="9999"),
        variant(productId="prod_2", variantId="variant_2", upc="9999"),
    ]
    assert find_barcode_conflicts(variants) == []


def test_blank_and_none_values_are_ignored():
    variants = [
        variant(productId="prod_1", variantId="variant_1", barcode=""),
        variant(productId="prod_2", variantId="variant_2", barcode=None),
    ]
    assert find_barcode_conflicts(variants) == []


def test_conflicts_are_sorted_by_field_then_value():
    variants = [
        variant(productId="prod_1", variantId="variant_1", upc="500"),
        variant(productId="prod_2", variantId="variant_2", upc="500"),
        variant(productId="prod_3", variantId="variant_3", barcode="100"),
        variant(productId="prod_4", variantId="variant_4", barcode="100"),
    ]
    conflicts = find_barcode_conflicts(variants)
    assert [c["field"] for c in conflicts] == ["barcode", "upc"]


def test_three_way_collision_reports_all_three_entries():
    variants = [
        variant(productId="prod_1", variantId="variant_1", ean="7777"),
        variant(productId="prod_2", variantId="variant_2", ean="7777"),
        variant(productId="prod_3", variantId="variant_3", ean="7777"),
    ]
    conflicts = find_barcode_conflicts(variants)
    assert len(conflicts) == 1
    assert len(conflicts[0]["entries"]) == 3


def test_same_product_and_cross_product_repeats_do_not_double_count():
    variants = [
        variant(productId="prod_1", variantId="variant_1", barcode="1111"),
        variant(productId="prod_1", variantId="variant_2", barcode="1111"),
        variant(productId="prod_2", variantId="variant_3", barcode="1111"),
    ]
    conflicts = find_barcode_conflicts(variants)
    assert len(conflicts) == 1
    assert len(conflicts[0]["entries"]) == 3
