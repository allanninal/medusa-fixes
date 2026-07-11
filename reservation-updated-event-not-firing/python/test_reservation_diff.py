from reconcile_reservation_sync import diff_reservation_sync, location_level_mismatches


def res(**over):
    base = {"id": "res_1", "quantity": 5, "location_id": "sloc_1", "updated_at": "2026-07-10T00:00:00Z"}
    base.update(over)
    return base


def test_flags_reservation_missing_from_last_synced():
    result = diff_reservation_sync([res()], {})
    assert result == [{"id": "res_1", "drift": 5, "stale_since": "2026-07-10T00:00:00Z"}]


def test_flags_reservation_when_quantity_changed():
    last_synced = {"res_1": {"quantity": 3, "updated_at": "2026-07-01T00:00:00Z"}}
    result = diff_reservation_sync([res(quantity=7)], last_synced)
    assert result == [{"id": "res_1", "drift": 4, "stale_since": "2026-07-01T00:00:00Z"}]


def test_no_drift_when_quantity_matches():
    last_synced = {"res_1": {"quantity": 5, "updated_at": "2026-07-01T00:00:00Z"}}
    result = diff_reservation_sync([res()], last_synced)
    assert result == []


def test_negative_drift_when_quantity_decreased():
    last_synced = {"res_1": {"quantity": 9, "updated_at": "2026-07-01T00:00:00Z"}}
    result = diff_reservation_sync([res(quantity=2)], last_synced)
    assert result == [{"id": "res_1", "drift": -7, "stale_since": "2026-07-01T00:00:00Z"}]


def test_multiple_reservations_only_flags_changed_ones():
    last_synced = {
        "res_1": {"quantity": 5, "updated_at": "2026-07-01T00:00:00Z"},
        "res_2": {"quantity": 1, "updated_at": "2026-07-02T00:00:00Z"},
    }
    live = [res(id="res_1", quantity=5), res(id="res_2", quantity=3)]
    result = diff_reservation_sync(live, last_synced)
    assert result == [{"id": "res_2", "drift": 2, "stale_since": "2026-07-02T00:00:00Z"}]


def test_empty_live_list_returns_empty():
    assert diff_reservation_sync([], {"res_1": {"quantity": 5, "updated_at": "2026-07-01T00:00:00Z"}}) == []


def test_location_level_mismatch_flagged_when_sums_disagree():
    reservations_by_location = {"sloc_1": [{"quantity": 3, "inventory_item_id": "iitem_1"}]}
    levels = [{"location_id": "sloc_1", "inventory_item_id": "iitem_1", "reserved_quantity": 5}]
    result = location_level_mismatches(reservations_by_location, levels)
    assert result == [{"location_id": "sloc_1", "inventory_item_id": "iitem_1", "reserved_quantity": 5, "live_sum": 3}]


def test_location_level_matches_when_sums_agree():
    reservations_by_location = {"sloc_1": [{"quantity": 3, "inventory_item_id": "iitem_1"}, {"quantity": 2, "inventory_item_id": "iitem_1"}]}
    levels = [{"location_id": "sloc_1", "inventory_item_id": "iitem_1", "reserved_quantity": 5}]
    result = location_level_mismatches(reservations_by_location, levels)
    assert result == []


def test_location_level_ignores_other_inventory_items():
    reservations_by_location = {"sloc_1": [{"quantity": 3, "inventory_item_id": "iitem_other"}]}
    levels = [{"location_id": "sloc_1", "inventory_item_id": "iitem_1", "reserved_quantity": 0}]
    result = location_level_mismatches(reservations_by_location, levels)
    assert result == []
