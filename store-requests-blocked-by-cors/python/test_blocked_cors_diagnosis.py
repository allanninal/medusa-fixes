from diagnose_store_cors import diagnose_cors_gap


def test_missing_publishable_key_wins_over_everything():
    result = diagnose_cors_gap(["https://shop.example.com"], "https://shop.example.com", False)
    assert result["verdict"] == "NOT_CORS_PAK_ISSUE"


def test_exact_match_is_ok():
    result = diagnose_cors_gap(["https://shop.example.com"], "https://shop.example.com", True)
    assert result["verdict"] == "OK"


def test_scheme_mismatch_is_reported():
    result = diagnose_cors_gap(["http://shop.example.com"], "https://shop.example.com", True)
    assert result["verdict"] == "CORS_MISMATCH"
    assert "https" in result["reason"] and "http" in result["reason"]


def test_www_variant_not_configured_is_mismatch():
    result = diagnose_cors_gap(["https://shop.example.com"], "https://www.shop.example.com", True)
    assert result["verdict"] == "CORS_MISMATCH"


def test_trailing_slash_is_ignored_in_normalization():
    result = diagnose_cors_gap(["https://shop.example.com/"], "https://shop.example.com", True)
    assert result["verdict"] == "OK"


def test_case_is_ignored_in_scheme_and_host():
    result = diagnose_cors_gap(["HTTPS://Shop.Example.com"], "https://shop.example.com", True)
    assert result["verdict"] == "OK"


def test_completely_unknown_host_is_mismatch():
    result = diagnose_cors_gap(["https://shop.example.com"], "https://other-store.example.com", True)
    assert result["verdict"] == "CORS_MISMATCH"
    assert "no matching host" in result["reason"]


def test_port_mismatch_is_reported():
    result = diagnose_cors_gap(["http://localhost:8000"], "http://localhost:3000", True)
    assert result["verdict"] == "CORS_MISMATCH"


def test_multiple_configured_origins_matches_correct_one():
    configured = ["https://shop.example.com", "http://localhost:8000"]
    result = diagnose_cors_gap(configured, "http://localhost:8000", True)
    assert result["verdict"] == "OK"
