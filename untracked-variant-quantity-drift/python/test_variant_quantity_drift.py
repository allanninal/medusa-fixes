from detect_untracked_drift import detect_untracked_quantity_drift


def variant(**over):
    base = {
        "variantId": "variant_1",
        "manageInventory": False,
        "inventoryItemId": "iitem_1",
        "locationLevels": [{"locationId": "sloc_1", "stockedQuantity": 8}],
    }
    base.update(over)
    return base


def baseline_of(qty, item_id="iitem_1", location_id="sloc_1"):
    return {item_id: {location_id: qty}}


def test_no_drift_when_quantity_unchanged():
    result = detect_untracked_quantity_drift([variant()], baseline_of(8))
    assert result == []


def test_flags_drop_in_stocked_quantity():
    result = detect_untracked_quantity_drift([variant()], baseline_of(10))
    assert len(result) == 1
    record = result[0]
    assert record["variantId"] == "variant_1"
    assert record["inventoryItemId"] == "iitem_1"
    assert record["locationId"] == "sloc_1"
    assert record["baselineQuantity"] == 10
    assert record["currentQuantity"] == 8
    assert record["delta"] == -2


def test_flags_increase_too_since_any_change_is_suspect():
    result = detect_untracked_quantity_drift([variant()], baseline_of(5))
    assert len(result) == 1
    assert result[0]["delta"] == 3


def test_skips_tracked_variants():
    result = detect_untracked_quantity_drift([variant(manageInventory=True)], baseline_of(999))
    assert result == []


def test_skips_variant_with_no_inventory_item():
    result = detect_untracked_quantity_drift([variant(inventoryItemId=None)], baseline_of(999))
    assert result == []


def test_skips_variant_with_no_location_levels():
    result = detect_untracked_quantity_drift([variant(locationLevels=[])], baseline_of(999))
    assert result == []


def test_skips_location_missing_from_baseline():
    result = detect_untracked_quantity_drift([variant()], {"iitem_1": {}})
    assert result == []


def test_skips_inventory_item_missing_from_baseline_entirely():
    result = detect_untracked_quantity_drift([variant()], {})
    assert result == []


def test_multiple_locations_only_flags_the_changed_one():
    v = variant(locationLevels=[
        {"locationId": "sloc_1", "stockedQuantity": 8},
        {"locationId": "sloc_2", "stockedQuantity": 4},
    ])
    baseline = {"iitem_1": {"sloc_1": 10, "sloc_2": 4}}
    result = detect_untracked_quantity_drift([v], baseline)
    assert len(result) == 1
    assert result[0]["locationId"] == "sloc_1"
