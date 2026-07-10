from create_missing_levels import decide_inventory_repair


def variant(**over):
    base = {"manageInventory": True, "inventoryItemId": "iitem_1"}
    base.update(over)
    return base


def test_untracked_variant_is_skipped():
    result = decide_inventory_repair(variant(manageInventory=False), [], ["sloc_1"])
    assert result == {"action": "skip", "missingLocationIds": []}


def test_managed_variant_without_inventory_item_is_flagged():
    result = decide_inventory_repair(variant(inventoryItemId=None), [], ["sloc_1"])
    assert result == {"action": "flag_no_inventory_item", "missingLocationIds": []}


def test_managed_variant_with_all_required_levels_is_ok():
    levels = [{"locationId": "sloc_1", "stockedQuantity": 5}]
    result = decide_inventory_repair(variant(), levels, ["sloc_1"])
    assert result == {"action": "ok", "missingLocationIds": []}


def test_managed_variant_with_no_levels_at_all_needs_repair():
    result = decide_inventory_repair(variant(), [], ["sloc_1"])
    assert result == {"action": "create_zero_level", "missingLocationIds": ["sloc_1"]}


def test_managed_variant_with_level_at_wrong_location_needs_repair():
    levels = [{"locationId": "sloc_wrong", "stockedQuantity": 10}]
    result = decide_inventory_repair(variant(), levels, ["sloc_1"])
    assert result == {"action": "create_zero_level", "missingLocationIds": ["sloc_1"]}


def test_only_missing_locations_are_returned_when_some_exist():
    levels = [{"locationId": "sloc_1", "stockedQuantity": 3}]
    result = decide_inventory_repair(variant(), levels, ["sloc_1", "sloc_2"])
    assert result == {"action": "create_zero_level", "missingLocationIds": ["sloc_2"]}


def test_no_required_locations_means_ok():
    result = decide_inventory_repair(variant(), [], [])
    assert result == {"action": "ok", "missingLocationIds": []}


def test_multiple_missing_locations_are_all_returned():
    result = decide_inventory_repair(variant(), [], ["sloc_1", "sloc_2", "sloc_3"])
    assert result == {"action": "create_zero_level", "missingLocationIds": ["sloc_1", "sloc_2", "sloc_3"]}
