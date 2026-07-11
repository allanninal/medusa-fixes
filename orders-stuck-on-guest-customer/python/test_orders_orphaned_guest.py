from reconcile_guest_orders import find_orphaned_guest_orders


def customer(cid, email, has_account):
    return {"id": cid, "email": email, "has_account": has_account}


def order(oid, customer_id, email):
    return {"id": oid, "customer_id": customer_id, "email": email}


def test_single_guest_with_no_registered_row_is_not_flagged():
    customers = [customer("cus_1", "a@example.com", False)]
    orders = [order("order_1", "cus_1", "a@example.com")]
    assert find_orphaned_guest_orders(customers, orders) == []


def test_single_registered_row_is_not_flagged():
    customers = [customer("cus_1", "a@example.com", True)]
    assert find_orphaned_guest_orders(customers, []) == []


def test_guest_plus_registered_pair_is_flagged_with_its_orders():
    customers = [
        customer("cus_guest", "a@example.com", False),
        customer("cus_reg", "a@example.com", True),
    ]
    orders = [
        order("order_1", "cus_guest", "a@example.com"),
        order("order_2", "cus_guest", "a@example.com"),
        order("order_3", "cus_reg", "a@example.com"),
    ]
    result = find_orphaned_guest_orders(customers, orders)
    assert len(result) == 1
    assert result[0]["guestCustomerId"] == "cus_guest"
    assert result[0]["registeredCustomerId"] == "cus_reg"
    assert sorted(result[0]["orderIds"]) == ["order_1", "order_2"]


def test_pair_with_no_orders_on_guest_id_returns_empty_order_list():
    customers = [
        customer("cus_guest", "a@example.com", False),
        customer("cus_reg", "a@example.com", True),
    ]
    result = find_orphaned_guest_orders(customers, [])
    assert result[0]["orderIds"] == []


def test_email_is_normalized_before_grouping():
    customers = [
        customer("cus_guest", "  A@Example.com ", False),
        customer("cus_reg", "a@example.com", True),
    ]
    orders = [order("order_1", "cus_guest", "a@example.com")]
    result = find_orphaned_guest_orders(customers, orders)
    assert len(result) == 1
    assert result[0]["orderIds"] == ["order_1"]


def test_two_registered_rows_sharing_email_is_not_this_pattern():
    customers = [
        customer("cus_reg1", "a@example.com", True),
        customer("cus_reg2", "a@example.com", True),
    ]
    assert find_orphaned_guest_orders(customers, []) == []


def test_two_guest_rows_sharing_email_is_not_this_pattern():
    customers = [
        customer("cus_g1", "a@example.com", False),
        customer("cus_g2", "a@example.com", False),
    ]
    assert find_orphaned_guest_orders(customers, []) == []


def test_different_emails_are_separate_groups():
    customers = [
        customer("cus_1", "a@example.com", False),
        customer("cus_2", "b@example.com", True),
    ]
    assert find_orphaned_guest_orders(customers, []) == []


def test_empty_input_returns_empty_list():
    assert find_orphaned_guest_orders([], []) == []
