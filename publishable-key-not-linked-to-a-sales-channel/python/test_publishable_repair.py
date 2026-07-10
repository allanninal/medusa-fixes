from link_publishable_key import decide_api_key_repair


def api_key(**over):
    base = {"id": "pk_1", "revoked_at": None, "sales_channels": []}
    base.update(over)
    return base


def test_revoked_key_is_left_alone():
    result = decide_api_key_repair(api_key(revoked_at="2026-01-01T00:00:00Z"), "sc_default")
    assert result == {"action": "none", "reason": "key revoked"}


def test_revoked_takes_priority_over_empty_channels():
    result = decide_api_key_repair(api_key(revoked_at="2026-01-01T00:00:00Z", sales_channels=[]), "sc_default")
    assert result == {"action": "none", "reason": "key revoked"}


def test_key_with_active_link_is_left_alone():
    result = decide_api_key_repair(api_key(sales_channels=[{"id": "sc_1", "is_disabled": False}]), "sc_default")
    assert result == {"action": "none", "reason": "already linked to an active sales channel"}


def test_key_with_mixed_disabled_and_enabled_links_is_left_alone():
    result = decide_api_key_repair(
        api_key(sales_channels=[{"id": "sc_1", "is_disabled": True}, {"id": "sc_2", "is_disabled": False}]),
        "sc_default",
    )
    assert result == {"action": "none", "reason": "already linked to an active sales channel"}


def test_key_with_only_disabled_links_and_no_default_is_flagged():
    result = decide_api_key_repair(api_key(sales_channels=[{"id": "sc_1", "is_disabled": True}]), None)
    assert result == {"action": "flag", "reason": "no sales channel linked and no unambiguous default to link"}


def test_key_with_zero_links_and_no_default_is_flagged():
    result = decide_api_key_repair(api_key(sales_channels=[]), None)
    assert result == {"action": "flag", "reason": "no sales channel linked and no unambiguous default to link"}


def test_key_with_zero_active_links_and_a_default_is_linked():
    result = decide_api_key_repair(api_key(sales_channels=[{"id": "sc_1", "is_disabled": True}]), "sc_default")
    assert result == {
        "action": "link",
        "reason": "key has zero active sales-channel links",
        "sales_channel_id_to_add": "sc_default",
    }


def test_key_with_no_sales_channels_at_all_and_a_default_is_linked():
    result = decide_api_key_repair(api_key(sales_channels=[]), "sc_default")
    assert result == {
        "action": "link",
        "reason": "key has zero active sales-channel links",
        "sales_channel_id_to_add": "sc_default",
    }
