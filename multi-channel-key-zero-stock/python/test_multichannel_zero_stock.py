from diagnose_multi_channel_zero_stock import diagnose_zero_stock_mismatch


LEVELS = {
    "sloc_1": {"stockedQuantity": 20, "reservedQuantity": 5},
    "sloc_2": {"stockedQuantity": 10, "reservedQuantity": 0},
}
LOCATIONS_BY_CHANNEL = {
    "sc_1": ["sloc_1"],
    "sc_2": ["sloc_2"],
}


def test_single_channel_ok_is_not_a_bug():
    result = diagnose_zero_stock_mismatch(["sc_1"], LEVELS, LOCATIONS_BY_CHANNEL, 15)
    assert result == {"isBug": False, "expectedAvailable": 15, "reason": "ok"}


def test_multi_channel_healthy_is_not_a_bug():
    result = diagnose_zero_stock_mismatch(["sc_1", "sc_2"], LEVELS, LOCATIONS_BY_CHANNEL, 25)
    assert result == {"isBug": False, "expectedAvailable": 25, "reason": "ok"}


def test_multi_channel_zero_stock_is_the_bug():
    result = diagnose_zero_stock_mismatch(["sc_1", "sc_2"], LEVELS, LOCATIONS_BY_CHANNEL, 0)
    assert result == {"isBug": True, "expectedAvailable": 25, "reason": "multi-channel-key-zero-stock"}


def test_single_channel_zero_stock_is_not_flagged_as_the_bug():
    # length == 1, so this is not the multi-channel fingerprint even if store reports 0
    result = diagnose_zero_stock_mismatch(["sc_1"], LEVELS, LOCATIONS_BY_CHANNEL, 0)
    assert result["isBug"] is False


def test_genuinely_out_of_stock_across_all_channels():
    empty_levels = {
        "sloc_1": {"stockedQuantity": 0, "reservedQuantity": 0},
        "sloc_2": {"stockedQuantity": 3, "reservedQuantity": 3},
    }
    result = diagnose_zero_stock_mismatch(["sc_1", "sc_2"], empty_levels, LOCATIONS_BY_CHANNEL, 0)
    assert result == {"isBug": False, "expectedAvailable": 0, "reason": "genuinely-out-of-stock"}


def test_reserved_never_pushes_a_location_negative():
    over_reserved = {"sloc_1": {"stockedQuantity": 2, "reservedQuantity": 9}}
    result = diagnose_zero_stock_mismatch(["sc_1"], over_reserved, {"sc_1": ["sloc_1"]}, 0)
    assert result["expectedAvailable"] == 0


def test_unknown_channel_contributes_no_locations():
    result = diagnose_zero_stock_mismatch(["sc_1", "sc_missing"], LEVELS, LOCATIONS_BY_CHANNEL, 20)
    assert result["expectedAvailable"] == 15


def test_missing_location_level_is_skipped_not_errored():
    partial_by_channel = {"sc_1": ["sloc_1", "sloc_unknown"]}
    result = diagnose_zero_stock_mismatch(["sc_1"], LEVELS, partial_by_channel, 15)
    assert result == {"isBug": False, "expectedAvailable": 15, "reason": "ok"}
