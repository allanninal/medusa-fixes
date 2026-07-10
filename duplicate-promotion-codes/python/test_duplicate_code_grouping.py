from find_duplicate_promotion_codes import find_duplicate_promotion_codes


def promo(id, code, status="active", campaign_id=None):
    return {"id": id, "code": code, "status": status, "campaign_id": campaign_id}


def test_no_duplicates_returns_empty_map():
    promotions = [promo("promo_1", "SAVE10"), promo("promo_2", "WELCOME5")]
    assert find_duplicate_promotion_codes(promotions) == {}


def test_exact_duplicate_codes_are_grouped():
    promotions = [
        promo("promo_1", "SAVE10", campaign_id="camp_1"),
        promo("promo_2", "SAVE10", campaign_id="camp_2"),
    ]
    result = find_duplicate_promotion_codes(promotions)
    assert list(result.keys()) == ["SAVE10"]
    assert {p["id"] for p in result["SAVE10"]} == {"promo_1", "promo_2"}


def test_case_variant_duplicates_are_grouped():
    promotions = [
        promo("promo_1", "SAVE10"),
        promo("promo_2", "save10"),
    ]
    result = find_duplicate_promotion_codes(promotions)
    assert list(result.keys()) == ["SAVE10"]
    assert len(result["SAVE10"]) == 2


def test_whitespace_variant_duplicates_are_grouped():
    promotions = [
        promo("promo_1", "SAVE10"),
        promo("promo_2", "SAVE10 "),
        promo("promo_3", " SAVE10"),
    ]
    result = find_duplicate_promotion_codes(promotions)
    assert len(result) == 1
    assert len(result["SAVE10"]) == 3


def test_three_way_collision_is_a_single_group():
    promotions = [
        promo("promo_1", "WELCOME5"),
        promo("promo_2", "welcome5"),
        promo("promo_3", " Welcome5 "),
    ]
    result = find_duplicate_promotion_codes(promotions)
    assert len(result) == 1
    assert len(result["WELCOME5"]) == 3


def test_unrelated_codes_never_collide():
    promotions = [promo("promo_1", "SAVE10"), promo("promo_2", "SAVE20")]
    assert find_duplicate_promotion_codes(promotions) == {}


def test_single_promotion_never_forms_a_group():
    promotions = [promo("promo_1", "ONLYONE")]
    assert find_duplicate_promotion_codes(promotions) == {}


def test_empty_input_returns_empty_map():
    assert find_duplicate_promotion_codes([]) == {}


def test_mixed_duplicates_and_uniques_only_reports_the_duplicate_group():
    promotions = [
        promo("promo_1", "SAVE10"),
        promo("promo_2", "save10"),
        promo("promo_3", "UNIQUE1"),
    ]
    result = find_duplicate_promotion_codes(promotions)
    assert list(result.keys()) == ["SAVE10"]
    assert "UNIQUE1" not in result
