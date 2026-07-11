from find_stale_reservations import find_stale_reservations


def order(**over):
    base = {
        "id": "order_1",
        "status": "completed",
        "fulfillment_status": "fulfilled",
        "items": [{"id": "item_1"}],
    }
    base.update(over)
    return base


def reservation(**over):
    base = {"id": "res_1", "line_item_id": "item_1", "quantity": 2}
    base.update(over)
    return base


def test_flags_reservation_when_order_completed_and_fulfilled():
    result = find_stale_reservations([order()], [reservation()])
    assert result == [
        {"reservation_id": "res_1", "order_id": "order_1", "line_item_id": "item_1", "quantity": 2}
    ]


def test_flags_reservation_when_order_canceled_and_fulfillment_canceled():
    o = order(status="canceled", fulfillment_status="canceled")
    result = find_stale_reservations([o], [reservation()])
    assert len(result) == 1


def test_keeps_reservation_when_order_still_in_progress():
    o = order(status="pending", fulfillment_status="not_fulfilled")
    result = find_stale_reservations([o], [reservation()])
    assert result == []


def test_keeps_reservation_when_order_completed_but_fulfillment_not_terminal():
    o = order(status="completed", fulfillment_status="partially_fulfilled")
    result = find_stale_reservations([o], [reservation()])
    assert result == []


def test_keeps_reservation_with_no_matching_line_item():
    result = find_stale_reservations([order()], [reservation(line_item_id="item_unknown")])
    assert result == []


def test_keeps_reservation_with_no_line_item_id():
    result = find_stale_reservations([order()], [reservation(line_item_id=None)])
    assert result == []


def test_handles_multiple_orders_and_multiple_reservations():
    orders = [
        order(id="order_1", items=[{"id": "item_1"}]),
        order(id="order_2", status="pending", fulfillment_status="not_fulfilled", items=[{"id": "item_2"}]),
    ]
    reservations = [
        reservation(id="res_1", line_item_id="item_1", quantity=2),
        reservation(id="res_2", line_item_id="item_2", quantity=5),
    ]
    result = find_stale_reservations(orders, reservations)
    assert result == [
        {"reservation_id": "res_1", "order_id": "order_1", "line_item_id": "item_1", "quantity": 2}
    ]
