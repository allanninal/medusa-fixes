from backfill_external_id import decide_external_id_backfill


def order(**over):
    base = {
        "id": "order_1",
        "display_id": 1042,
        "metadata": None,
        "created_at": "2026-07-01T00:00:00Z",
        "email": "buyer@example.com",
        "total": 150.0,
    }
    base.update(over)
    return base


def candidate(**over):
    base = {
        "legacyId": "LEG-1042",
        "display_id": 1042,
        "email": "buyer@example.com",
        "total": 150.0,
        "created_at": "2026-07-01T00:00:00Z",
    }
    base.update(over)
    return base


def test_skip_when_already_has_external_id():
    o = order(metadata={"external_id": "LEG-9999"})
    result = decide_external_id_backfill(o, [candidate()])
    assert result["action"] == "skip_has_id"


def test_apply_on_exact_display_id_match():
    result = decide_external_id_backfill(order(), [candidate()])
    assert result["action"] == "apply"
    assert result["external_id"] == "LEG-1042"


def test_flag_no_match_when_display_id_absent_from_export():
    result = decide_external_id_backfill(order(), [candidate(display_id=9999)])
    assert result["action"] == "flag_no_match"


def test_flag_ambiguous_when_multiple_display_id_matches():
    result = decide_external_id_backfill(
        order(), [candidate(legacyId="LEG-A"), candidate(legacyId="LEG-B")]
    )
    assert result["action"] == "flag_ambiguous"


def test_falls_back_to_fuzzy_match_without_display_id():
    o = order(display_id=None)
    result = decide_external_id_backfill(o, [candidate(display_id=None)])
    assert result["action"] == "apply"
    assert result["external_id"] == "LEG-1042"


def test_fuzzy_match_rejects_total_outside_epsilon():
    o = order(display_id=None)
    result = decide_external_id_backfill(o, [candidate(display_id=None, total=200.0)])
    assert result["action"] == "flag_no_match"


def test_fuzzy_match_rejects_created_at_outside_day_window():
    o = order(display_id=None)
    result = decide_external_id_backfill(
        o, [candidate(display_id=None, created_at="2026-07-10T00:00:00Z")]
    )
    assert result["action"] == "flag_no_match"


def test_fuzzy_match_rejects_missing_email():
    o = order(display_id=None, email=None)
    result = decide_external_id_backfill(o, [candidate(display_id=None)])
    assert result["action"] == "flag_no_match"


def test_empty_string_external_id_is_treated_as_missing():
    o = order(metadata={"external_id": ""})
    result = decide_external_id_backfill(o, [candidate()])
    assert result["action"] == "apply"


def test_no_candidates_at_all_is_no_match():
    result = decide_external_id_backfill(order(), [])
    assert result["action"] == "flag_no_match"
