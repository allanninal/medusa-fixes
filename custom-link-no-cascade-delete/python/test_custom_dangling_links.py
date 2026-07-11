from find_dangling_links import find_dangling_links


def test_no_dangling_when_all_products_live():
    live = {"prod_1", "prod_2"}
    rows = [{"id": "l1", "product_id": "prod_1"}, {"id": "l2", "product_id": "prod_2"}]
    assert find_dangling_links(live, rows) == []


def test_finds_the_single_dangling_row():
    live = {"prod_1", "prod_2"}
    rows = [{"id": "l1", "product_id": "prod_1"}, {"id": "l2", "product_id": "prod_999"}]
    assert find_dangling_links(live, rows) == [{"id": "l2", "product_id": "prod_999"}]


def test_finds_multiple_dangling_rows():
    live = {"prod_1"}
    rows = [
        {"id": "l1", "product_id": "prod_1"},
        {"id": "l2", "product_id": "prod_404"},
        {"id": "l3", "product_id": "prod_405"},
    ]
    result = find_dangling_links(live, rows)
    assert {r["id"] for r in result} == {"l2", "l3"}


def test_empty_link_rows_returns_empty():
    assert find_dangling_links({"prod_1"}, []) == []


def test_empty_live_set_flags_every_row():
    rows = [{"id": "l1", "product_id": "prod_1"}, {"id": "l2", "product_id": "prod_2"}]
    result = find_dangling_links(set(), rows)
    assert len(result) == 2


def test_preserves_row_order_of_input():
    live = {"prod_1"}
    rows = [
        {"id": "l3", "product_id": "prod_999"},
        {"id": "l1", "product_id": "prod_1"},
        {"id": "l2", "product_id": "prod_998"},
    ]
    result = find_dangling_links(live, rows)
    assert [r["id"] for r in result] == ["l3", "l2"]
