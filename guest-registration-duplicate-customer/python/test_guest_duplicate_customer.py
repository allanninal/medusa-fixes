from detect_duplicate_customers import find_duplicate_customer_groups


def customer(cid, email, has_account):
    return {"id": cid, "email": email, "has_account": has_account}


def test_single_guest_is_not_a_duplicate():
    rows = [customer("cus_1", "a@example.com", False)]
    result = find_duplicate_customer_groups(rows)
    assert len(result) == 1
    assert result[0]["isDuplicate"] is False
    assert result[0]["guestId"] == "cus_1"
    assert result[0]["registeredId"] is None


def test_single_registered_is_not_a_duplicate():
    rows = [customer("cus_1", "a@example.com", True)]
    result = find_duplicate_customer_groups(rows)
    assert result[0]["isDuplicate"] is False
    assert result[0]["registeredId"] == "cus_1"
    assert result[0]["guestId"] is None


def test_guest_plus_registered_is_flagged_as_duplicate():
    rows = [
        customer("cus_guest", "a@example.com", False),
        customer("cus_reg", "a@example.com", True),
    ]
    result = find_duplicate_customer_groups(rows)
    assert len(result) == 1
    assert result[0]["isDuplicate"] is True
    assert result[0]["guestId"] == "cus_guest"
    assert result[0]["registeredId"] == "cus_reg"


def test_email_is_normalized_before_grouping():
    rows = [
        customer("cus_guest", "  A@Example.com ", False),
        customer("cus_reg", "a@example.com", True),
    ]
    result = find_duplicate_customer_groups(rows)
    assert len(result) == 1
    assert result[0]["email"] == "a@example.com"
    assert result[0]["isDuplicate"] is True


def test_two_registered_rows_are_not_this_pattern():
    rows = [
        customer("cus_reg1", "a@example.com", True),
        customer("cus_reg2", "a@example.com", True),
    ]
    result = find_duplicate_customer_groups(rows)
    assert result[0]["isDuplicate"] is False


def test_two_guest_rows_are_not_this_pattern():
    rows = [
        customer("cus_g1", "a@example.com", False),
        customer("cus_g2", "a@example.com", False),
    ]
    result = find_duplicate_customer_groups(rows)
    assert result[0]["isDuplicate"] is False


def test_different_emails_are_separate_groups():
    rows = [
        customer("cus_1", "a@example.com", False),
        customer("cus_2", "b@example.com", True),
    ]
    result = find_duplicate_customer_groups(rows)
    assert len(result) == 2
    assert all(r["isDuplicate"] is False for r in result)


def test_empty_input_returns_empty_list():
    assert find_duplicate_customer_groups([]) == []
