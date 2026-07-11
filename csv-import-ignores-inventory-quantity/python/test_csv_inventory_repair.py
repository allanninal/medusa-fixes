from repair_import_inventory import decide_inventory_repair


def csv_row(qty=200, sku="SKU-1"):
    return {"sku": sku, "variantInventoryQuantity": qty}


def variant(inventory_item_id="iitem_1", sku="SKU-1"):
    return {"id": "variant_1", "sku": sku, "inventoryItemId": inventory_item_id}


def level(location_id="sloc_default", stocked_quantity=0):
    return {"location_id": location_id, "stocked_quantity": stocked_quantity}


def test_csv_had_no_quantity_does_nothing():
    assert decide_inventory_repair(csv_row(qty=0), variant(), [], "sloc_default") is None


def test_csv_had_negative_quantity_does_nothing():
    assert decide_inventory_repair(csv_row(qty=-5), variant(), [], "sloc_default") is None


def test_no_inventory_item_does_nothing():
    result = decide_inventory_repair(csv_row(), variant(inventory_item_id=None), [], "sloc_default")
    assert result is None


def test_empty_location_levels_creates_a_level():
    result = decide_inventory_repair(csv_row(), variant(), [], "sloc_default")
    assert result == {
        "action": "create_level",
        "inventoryItemId": "iitem_1",
        "locationId": "sloc_default",
        "fromQty": 0,
        "toQty": 200,
    }


def test_level_at_zero_updates_to_csv_quantity():
    result = decide_inventory_repair(csv_row(), variant(), [level(stocked_quantity=0)], "sloc_default")
    assert result == {
        "action": "update_level",
        "inventoryItemId": "iitem_1",
        "locationId": "sloc_default",
        "fromQty": 0,
        "toQty": 200,
    }


def test_level_already_matching_csv_does_nothing():
    result = decide_inventory_repair(csv_row(), variant(), [level(stocked_quantity=200)], "sloc_default")
    assert result is None


def test_level_at_a_different_location_creates_the_default_level():
    result = decide_inventory_repair(csv_row(), variant(), [level(location_id="sloc_other", stocked_quantity=50)], "sloc_default")
    assert result["action"] == "create_level"
    assert result["toQty"] == 200


def test_level_with_a_different_nonzero_quantity_updates():
    result = decide_inventory_repair(csv_row(qty=75), variant(), [level(stocked_quantity=10)], "sloc_default")
    assert result == {
        "action": "update_level",
        "inventoryItemId": "iitem_1",
        "locationId": "sloc_default",
        "fromQty": 10,
        "toQty": 75,
    }
