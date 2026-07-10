from classify_inventory_risk import classify_variant_inventory_risk


def variant(**over):
    base = {
        "id": "variant_1",
        "sku": "SKU-1",
        "manage_inventory": True,
        "inventory_items": [{"id": "iitem_1", "inventory": {"location_levels": [{"stocked_quantity": 5}]}}],
        "product_tags": [],
    }
    base.update(over)
    return base


def test_ok_when_managed_and_stocked():
    assert classify_variant_inventory_risk(variant()) == "ok"


def test_unmanaged_risk_when_flag_false():
    assert classify_variant_inventory_risk(variant(manage_inventory=False)) == "unmanaged_risk"


def test_unmanaged_risk_when_flag_missing():
    assert classify_variant_inventory_risk(variant(manage_inventory=None)) == "unmanaged_risk"


def test_managed_but_untracked_when_no_inventory_items():
    assert classify_variant_inventory_risk(variant(inventory_items=[])) == "managed_but_untracked"


def test_managed_but_untracked_when_no_location_levels_have_stock():
    v = variant(inventory_items=[{"id": "iitem_1", "inventory": {"location_levels": [{"stocked_quantity": 0}]}}])
    assert classify_variant_inventory_risk(v) == "managed_but_untracked"


def test_managed_but_untracked_when_inventory_items_have_no_inventory_key():
    v = variant(inventory_items=[{"id": "iitem_1"}])
    assert classify_variant_inventory_risk(v) == "managed_but_untracked"


def test_exempt_wins_even_when_unmanaged():
    v = variant(manage_inventory=False, product_tags=["digital"])
    assert classify_variant_inventory_risk(v) == "exempt"


def test_exempt_with_custom_tag_list():
    v = variant(manage_inventory=False, product_tags=["subscription"])
    assert classify_variant_inventory_risk(v, exempt_tags=("subscription",)) == "exempt"


def test_ok_when_multiple_location_levels_and_one_has_stock():
    v = variant(inventory_items=[{
        "id": "iitem_1",
        "inventory": {"location_levels": [{"stocked_quantity": 0}, {"stocked_quantity": 3}]},
    }])
    assert classify_variant_inventory_risk(v) == "ok"
