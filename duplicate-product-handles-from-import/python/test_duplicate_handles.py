from find_duplicate_handles import find_duplicate_handles


def product(**over):
    base = {"id": "prod_1", "handle": "a-shirt", "title": "A Shirt", "created_at": "2026-01-01T00:00:00Z"}
    base.update(over)
    return base


def test_no_duplicates_returns_empty_list():
    products = [product(id="prod_1", handle="a-shirt"), product(id="prod_2", handle="b-shirt")]
    assert find_duplicate_handles(products) == []


def test_two_products_sharing_a_handle_are_grouped():
    products = [
        product(id="prod_1", handle="a-shirt", created_at="2026-01-02T00:00:00Z"),
        product(id="prod_2", handle="a-shirt", created_at="2026-01-01T00:00:00Z"),
    ]
    groups = find_duplicate_handles(products)
    assert len(groups) == 1
    assert groups[0]["handle"] == "a-shirt"


def test_group_is_sorted_oldest_first():
    products = [
        product(id="prod_new", handle="a-shirt", created_at="2026-01-05T00:00:00Z"),
        product(id="prod_old", handle="a-shirt", created_at="2026-01-01T00:00:00Z"),
    ]
    groups = find_duplicate_handles(products)
    ids_in_order = [p["id"] for p in groups[0]["products"]]
    assert ids_in_order == ["prod_old", "prod_new"]


def test_three_way_collision_is_one_group_of_three():
    products = [
        product(id="prod_1", handle="a-shirt", created_at="2026-01-01T00:00:00Z"),
        product(id="prod_2", handle="a-shirt", created_at="2026-01-02T00:00:00Z"),
        product(id="prod_3", handle="a-shirt", created_at="2026-01-03T00:00:00Z"),
    ]
    groups = find_duplicate_handles(products)
    assert len(groups) == 1
    assert len(groups[0]["products"]) == 3


def test_unrelated_products_do_not_appear_in_any_group():
    products = [
        product(id="prod_1", handle="a-shirt", created_at="2026-01-01T00:00:00Z"),
        product(id="prod_2", handle="a-shirt", created_at="2026-01-02T00:00:00Z"),
        product(id="prod_3", handle="unique-hat", created_at="2026-01-03T00:00:00Z"),
    ]
    groups = find_duplicate_handles(products)
    assert len(groups) == 1
    all_ids = [p["id"] for p in groups[0]["products"]]
    assert "prod_3" not in all_ids


def test_missing_created_at_does_not_crash_sort():
    products = [
        product(id="prod_1", handle="a-shirt", created_at=None),
        product(id="prod_2", handle="a-shirt", created_at="2026-01-01T00:00:00Z"),
    ]
    groups = find_duplicate_handles(products)
    assert len(groups) == 1
    assert len(groups[0]["products"]) == 2
