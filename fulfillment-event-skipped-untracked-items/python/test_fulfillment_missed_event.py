from find_missed_fulfillment_events import is_fulfillment_event_likely_missed


def fulfillment(**over):
    base = {"id": "ful_1", "items": [{"line_item_id": "item_1"}]}
    base.update(over)
    return base


def test_missed_when_all_items_untracked_and_not_notified():
    items = {"item_1": {"manage_inventory": False}}
    assert is_fulfillment_event_likely_missed(fulfillment(), items, set()) is True


def test_not_missed_when_already_notified():
    items = {"item_1": {"manage_inventory": False}}
    assert is_fulfillment_event_likely_missed(fulfillment(), items, {"ful_1"}) is False


def test_not_missed_when_item_is_tracked():
    items = {"item_1": {"manage_inventory": True}}
    assert is_fulfillment_event_likely_missed(fulfillment(), items, set()) is False


def test_not_missed_when_mixed_tracked_and_untracked():
    f = fulfillment(items=[{"line_item_id": "item_1"}, {"line_item_id": "item_2"}])
    items = {"item_1": {"manage_inventory": False}, "item_2": {"manage_inventory": True}}
    assert is_fulfillment_event_likely_missed(f, items, set()) is False


def test_missing_lookup_defaults_to_untracked():
    assert is_fulfillment_event_likely_missed(fulfillment(), {}, set()) is True


def test_no_items_is_not_missed():
    assert is_fulfillment_event_likely_missed(fulfillment(items=[]), {}, set()) is False
