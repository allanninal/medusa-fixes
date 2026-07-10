from reconcile_stale_cart_prices import find_stale_cart_line_items


def cart(**over):
    base = {
        "id": "cart_1",
        "currency_code": "usd",
        "region_id": "reg_1",
        "completed_at": None,
        "line_items": [
            {
                "id": "item_1",
                "variant_id": "variant_1",
                "unit_price": 1000,
                "is_custom_price": False,
                "updated_at": "2026-07-01T00:00:00Z",
            }
        ],
    }
    base.update(over)
    return base


def live_map(**over):
    base = {
        "variant_1:usd:reg_1": {
            "amount": 1200,
            "currency_code": "usd",
            "region_id": "reg_1",
            "updated_at": "2026-07-05T00:00:00Z",
        }
    }
    base.update(over)
    return base


def test_flags_stale_line_item_touched_before_price_change():
    result = find_stale_cart_line_items([cart()], live_map())
    assert result == [{"cart_id": "cart_1", "line_item_id": "item_1", "old_price": 1000, "new_price": 1200}]


def test_skips_custom_price_line_item():
    c = cart()
    c["line_items"][0]["is_custom_price"] = True
    assert find_stale_cart_line_items([c], live_map()) == []


def test_skips_when_price_already_matches():
    c = cart()
    c["line_items"][0]["unit_price"] = 1200
    assert find_stale_cart_line_items([c], live_map()) == []


def test_skips_completed_cart():
    c = cart(completed_at="2026-07-06T00:00:00Z")
    assert find_stale_cart_line_items([c], live_map()) == []


def test_skips_line_item_touched_after_price_change():
    c = cart()
    c["line_items"][0]["updated_at"] = "2026-07-06T00:00:00Z"
    assert find_stale_cart_line_items([c], live_map()) == []


def test_skips_when_no_live_price_match():
    assert find_stale_cart_line_items([cart()], {}) == []


def test_multiple_carts_only_flags_stale_ones():
    stale_cart = cart(id="cart_1")
    fresh_cart = cart(id="cart_2")
    fresh_cart["line_items"][0]["id"] = "item_2"
    fresh_cart["line_items"][0]["unit_price"] = 1200
    result = find_stale_cart_line_items([stale_cart, fresh_cart], live_map())
    assert result == [{"cart_id": "cart_1", "line_item_id": "item_1", "old_price": 1000, "new_price": 1200}]
