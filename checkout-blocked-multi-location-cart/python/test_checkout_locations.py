from detect_multi_location_cart import resolve_item_locations, is_affected_cart


def level(location_id, stocked, reserved=0):
    return {"locationId": location_id, "stockedQuantity": stocked, "reservedQuantity": reserved}


def test_disjoint_locations_flags_the_cart():
    items = [
        {"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 1},
        {"lineItemId": "item_b", "inventoryItemId": "iitem_b", "requiredQty": 1},
    ]
    levels = {
        "iitem_a": [level("sloc_east", 5)],
        "iitem_b": [level("sloc_west", 5)],
    }
    item_locations = resolve_item_locations(items, levels, ["sloc_east", "sloc_west"])
    assert item_locations == [
        {"lineItemId": "item_a", "validLocationIds": ["sloc_east"]},
        {"lineItemId": "item_b", "validLocationIds": ["sloc_west"]},
    ]
    assert is_affected_cart(item_locations) is True


def test_shared_location_is_not_affected():
    items = [
        {"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 1},
        {"lineItemId": "item_b", "inventoryItemId": "iitem_b", "requiredQty": 1},
    ]
    levels = {
        "iitem_a": [level("sloc_east", 5), level("sloc_west", 5)],
        "iitem_b": [level("sloc_west", 5)],
    }
    item_locations = resolve_item_locations(items, levels, ["sloc_east", "sloc_west"])
    assert is_affected_cart(item_locations) is False


def test_item_with_no_valid_location_is_a_real_stockout_not_this_bug():
    items = [
        {"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 10},
        {"lineItemId": "item_b", "inventoryItemId": "iitem_b", "requiredQty": 1},
    ]
    levels = {
        "iitem_a": [level("sloc_east", 2)],
        "iitem_b": [level("sloc_west", 5)],
    }
    item_locations = resolve_item_locations(items, levels, ["sloc_east", "sloc_west"])
    assert item_locations[0]["validLocationIds"] == []
    assert is_affected_cart(item_locations) is False


def test_locations_outside_the_channel_are_excluded():
    items = [{"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 1}]
    levels = {"iitem_a": [level("sloc_unlinked", 100)]}
    item_locations = resolve_item_locations(items, levels, ["sloc_east"])
    assert item_locations == [{"lineItemId": "item_a", "validLocationIds": []}]
    assert is_affected_cart(item_locations) is False


def test_insufficient_quantity_at_a_location_excludes_it():
    items = [{"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 5}]
    levels = {"iitem_a": [level("sloc_east", 4)]}
    item_locations = resolve_item_locations(items, levels, ["sloc_east"])
    assert item_locations[0]["validLocationIds"] == []


def test_empty_cart_is_not_affected():
    assert is_affected_cart([]) is False


def test_reserved_quantity_reduces_available_stock():
    items = [{"lineItemId": "item_a", "inventoryItemId": "iitem_a", "requiredQty": 3}]
    levels = {"iitem_a": [level("sloc_east", 5, reserved=3)]}
    item_locations = resolve_item_locations(items, levels, ["sloc_east"])
    assert item_locations[0]["validLocationIds"] == []
