from classify_link_rename import classify_link_rename


def test_no_orphans_when_all_tables_defined():
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_article_post"],
        {"product_product_article_post": 42},
    )
    assert result == []


def test_orphaned_when_table_undefined_and_has_rows():
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_article_post", "product_product_blog_post"],
        {"product_product_article_post": 10, "product_product_blog_post": 87},
    )
    assert len(result) == 1
    assert result[0]["orphaned_table"] == "product_product_blog_post"
    assert result[0]["row_count"] == 87


def test_not_orphaned_when_undefined_table_is_empty():
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_article_post", "product_product_blog_post"],
        {"product_product_article_post": 10, "product_product_blog_post": 0},
    )
    assert result == []


def test_not_orphaned_when_undefined_table_missing_from_row_counts():
    # rowCounts.get(table, 0) should treat an absent key as zero rows.
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_article_post", "product_product_blog_post"],
        {"product_product_article_post": 10},
    )
    assert result == []


def test_suspected_rename_of_uses_shared_segments():
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_blog_post"],
        {"product_product_blog_post": 5},
    )
    assert result[0]["suspected_rename_of"] == "product_product_article_post"


def test_suspected_rename_of_is_none_with_no_overlap():
    result = classify_link_rename(
        ["sales_channel_stock_location"],
        ["product_product_blog_post"],
        {"product_product_blog_post": 5},
    )
    assert result[0]["suspected_rename_of"] is None


def test_multiple_orphans_reported_independently():
    result = classify_link_rename(
        ["product_product_article_post"],
        ["product_product_blog_post", "product_variant_old_inventory_item"],
        {"product_product_blog_post": 3, "product_variant_old_inventory_item": 9},
    )
    orphaned_names = {row["orphaned_table"] for row in result}
    assert orphaned_names == {"product_product_blog_post", "product_variant_old_inventory_item"}


def test_picks_best_overlap_among_multiple_candidates():
    result = classify_link_rename(
        ["product_product_article_post", "product_variant_article_post"],
        ["product_product_blog_post"],
        {"product_product_blog_post": 5},
    )
    assert result[0]["suspected_rename_of"] == "product_product_article_post"
