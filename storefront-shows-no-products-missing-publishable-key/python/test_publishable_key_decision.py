from fix_publishable_key_sales_channel import decide_publishable_key_fix


def key(**over):
    base = {
        "id": "pk_1",
        "revoked_at": None,
        "sales_channels": [{"id": "sc_1", "is_disabled": False}],
    }
    base.update(over)
    return base


def test_revoked_key_is_flagged():
    result = decide_publishable_key_fix(key(revoked_at="2026-01-01T00:00:00Z"), {"sc_1": 5})
    assert result == {"status": "revoked", "action": "flag"}


def test_no_sales_channels_is_linked():
    result = decide_publishable_key_fix(key(sales_channels=[]), {})
    assert result == {"status": "no_sales_channels", "action": "link_default_channel"}


def test_all_channels_disabled_is_flagged():
    result = decide_publishable_key_fix(
        key(sales_channels=[{"id": "sc_1", "is_disabled": True}, {"id": "sc_2", "is_disabled": True}]),
        {"sc_1": 5, "sc_2": 3},
    )
    assert result == {"status": "channels_disabled", "action": "flag"}


def test_mixed_disabled_and_enabled_is_not_channels_disabled():
    result = decide_publishable_key_fix(
        key(sales_channels=[{"id": "sc_1", "is_disabled": True}, {"id": "sc_2", "is_disabled": False}]),
        {"sc_1": 0, "sc_2": 5},
    )
    assert result == {"status": "ok", "action": "none"}


def test_all_channels_have_zero_products_is_flagged():
    result = decide_publishable_key_fix(key(), {"sc_1": 0})
    assert result == {"status": "channels_empty", "action": "flag"}


def test_missing_product_count_entry_counts_as_zero():
    result = decide_publishable_key_fix(key(), {})
    assert result == {"status": "channels_empty", "action": "flag"}


def test_healthy_key_is_ok():
    result = decide_publishable_key_fix(key(), {"sc_1": 12})
    assert result == {"status": "ok", "action": "none"}


def test_revoked_takes_priority_over_empty_channels():
    result = decide_publishable_key_fix(key(revoked_at="2026-01-01T00:00:00Z", sales_channels=[]), {})
    assert result == {"status": "revoked", "action": "flag"}


def test_one_channel_with_products_among_many_empty_is_ok():
    result = decide_publishable_key_fix(
        key(sales_channels=[{"id": "sc_1", "is_disabled": False}, {"id": "sc_2", "is_disabled": False}]),
        {"sc_1": 0, "sc_2": 4},
    )
    assert result == {"status": "ok", "action": "none"}
