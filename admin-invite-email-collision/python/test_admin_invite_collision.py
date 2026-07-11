from check_invite_collision import will_invite_collide


def test_ok_when_no_matches_anywhere():
    result = will_invite_collide("new@example.com", [], [], [])
    assert result == {"safe": True, "reason": "ok"}


def test_blocked_when_customer_has_account():
    customers = [{"email": "jane@example.com", "has_account": True}]
    result = will_invite_collide("jane@example.com", customers, [], [])
    assert result == {"safe": False, "reason": "customer_account_exists"}


def test_not_blocked_when_customer_has_no_account():
    customers = [{"email": "jane@example.com", "has_account": False}]
    result = will_invite_collide("jane@example.com", customers, [], [])
    assert result == {"safe": True, "reason": "ok"}


def test_blocked_when_admin_user_already_exists():
    admin_users = [{"email": "jane@example.com"}]
    result = will_invite_collide("jane@example.com", [], admin_users, [])
    assert result == {"safe": False, "reason": "admin_user_exists"}


def test_blocked_when_invite_already_pending():
    invites = [{"email": "jane@example.com", "accepted": False}]
    result = will_invite_collide("jane@example.com", [], [], invites)
    assert result == {"safe": False, "reason": "invite_pending"}


def test_not_blocked_when_invite_already_accepted():
    invites = [{"email": "jane@example.com", "accepted": True}]
    result = will_invite_collide("jane@example.com", [], [], invites)
    assert result == {"safe": True, "reason": "ok"}


def test_normalizes_case_and_whitespace():
    customers = [{"email": "Jane@Example.com", "has_account": True}]
    result = will_invite_collide("  jane@example.com  ", customers, [], [])
    assert result == {"safe": False, "reason": "customer_account_exists"}


def test_customer_check_wins_over_other_reasons():
    customers = [{"email": "jane@example.com", "has_account": True}]
    admin_users = [{"email": "jane@example.com"}]
    result = will_invite_collide("jane@example.com", customers, admin_users, [])
    assert result["reason"] == "customer_account_exists"


def test_no_match_when_email_differs():
    customers = [{"email": "someone-else@example.com", "has_account": True}]
    result = will_invite_collide("jane@example.com", customers, [], [])
    assert result == {"safe": True, "reason": "ok"}


def test_missing_email_field_does_not_crash():
    customers = [{"has_account": True}]
    result = will_invite_collide("jane@example.com", customers, [], [])
    assert result == {"safe": True, "reason": "ok"}
