from trace_reservation_orders import trace_reservations_to_orders


def reservation(**over):
    base = {"id": "res_1", "line_item_id": "item_1", "inventory_item_id": "iitem_1", "quantity": 2}
    base.update(over)
    return base


def order(**over):
    base = {"id": "order_1", "items": [{"id": "item_1"}]}
    base.update(over)
    return base


def test_traced_when_line_item_matches_an_order():
    result = trace_reservations_to_orders([reservation()], [order()])
    assert result == [{"reservation_id": "res_1", "order_id": "order_1", "status": "traced"}]


def test_no_line_item_when_reservation_has_none():
    r = reservation(line_item_id=None)
    result = trace_reservations_to_orders([r], [order()])
    assert result == [{"reservation_id": "res_1", "order_id": None, "status": "no_line_item"}]


def test_orphaned_line_item_when_no_order_matches():
    r = reservation(line_item_id="item_missing")
    result = trace_reservations_to_orders([r], [order()])
    assert result == [{"reservation_id": "res_1", "order_id": None, "status": "orphaned_line_item"}]


def test_orphaned_line_item_when_no_orders_at_all():
    result = trace_reservations_to_orders([reservation()], [])
    assert result[0]["status"] == "orphaned_line_item"


def test_multiple_reservations_resolve_independently():
    reservations = [
        reservation(id="res_1", line_item_id="item_1"),
        reservation(id="res_2", line_item_id=None),
        reservation(id="res_3", line_item_id="item_gone"),
    ]
    result = trace_reservations_to_orders(reservations, [order()])
    statuses = {r["reservation_id"]: r["status"] for r in result}
    assert statuses == {"res_1": "traced", "res_2": "no_line_item", "res_3": "orphaned_line_item"}


def test_empty_line_item_id_string_treated_as_no_line_item():
    r = reservation(line_item_id="")
    result = trace_reservations_to_orders([r], [order()])
    assert result == [{"reservation_id": "res_1", "order_id": None, "status": "no_line_item"}]
