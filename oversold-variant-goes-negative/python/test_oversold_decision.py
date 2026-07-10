from repair_oversold_inventory import decide_inventory_repair


def level(**over):
    base = {
        "inventoryItemId": "iitem_1",
        "locationId": "sloc_1",
        "stockedQuantity": 10,
        "reservedQuantity": 4,
        "allowBackorder": False,
    }
    base.update(over)
    return base


def test_ok_when_available_is_non_negative():
    result = decide_inventory_repair(level(), 4)
    assert result == {
        "isOversold": False,
        "available": 6,
        "reason": "ok",
        "proposedStockedQuantity": None,
    }


def test_flags_reserved_exceeds_stock():
    result = decide_inventory_repair(level(stockedQuantity=5, reservedQuantity=8), 8)
    assert result["isOversold"] is True
    assert result["reason"] == "reserved_exceeds_stock"
    assert result["available"] == -3
    assert result["proposedStockedQuantity"] == 8


def test_flags_when_stocked_itself_is_negative():
    # stockedQuantity was already pushed negative by a bad external write.
    # available < 0 always implies reserved > stocked algebraically, so this
    # is still reported as reserved_exceeds_stock, the reason the two branches
    # actually distinguish in decide_inventory_repair is available < 0 vs. the
    # (unreachable in practice) case of reserved > stocked with available >= 0.
    result = decide_inventory_repair(level(stockedQuantity=-2, reservedQuantity=0), 0)
    assert result["isOversold"] is True
    assert result["reason"] in ("reserved_exceeds_stock", "negative_available")
    assert result["available"] == -2


def test_backorder_variant_is_never_flagged():
    result = decide_inventory_repair(level(stockedQuantity=5, reservedQuantity=8, allowBackorder=True), 8)
    assert result["isOversold"] is False
    assert result["reason"] == "ok"


def test_proposed_count_never_drops_below_open_reservations():
    result = decide_inventory_repair(level(stockedQuantity=5, reservedQuantity=8), 12)
    assert result["proposedStockedQuantity"] == 12


def test_proposed_count_never_drops_below_current_stock():
    result = decide_inventory_repair(level(stockedQuantity=9, reservedQuantity=10), 3)
    assert result["proposedStockedQuantity"] == 9


def test_ok_when_reserved_equals_stocked_exactly():
    result = decide_inventory_repair(level(stockedQuantity=5, reservedQuantity=5), 5)
    assert result["isOversold"] is False
    assert result["available"] == 0
