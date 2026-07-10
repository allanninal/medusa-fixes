from link_stock_location import plan_stock_location_links


def sc(**over):
    base = {"id": "sc_1", "name": "Default channel", "stock_locations": []}
    base.update(over)
    return base


def loc(id_, name="Main warehouse"):
    return {"id": id_, "name": name}


def test_channel_with_linked_location_needs_no_link():
    plans = plan_stock_location_links([sc(stock_locations=[{"id": "sloc_1"}])], [loc("sloc_1")])
    assert plans == [{
        "sales_channel_id": "sc_1",
        "sales_channel_name": "Default channel",
        "needs_link": False,
        "suggested_location_id": None,
    }]


def test_channel_with_zero_locations_and_no_default_and_multiple_locations_is_flagged():
    plans = plan_stock_location_links([sc()], [loc("sloc_1"), loc("sloc_2")])
    assert plans == [{
        "sales_channel_id": "sc_1",
        "sales_channel_name": "Default channel",
        "needs_link": True,
        "suggested_location_id": None,
    }]


def test_channel_with_zero_locations_and_exactly_one_available_location_is_suggested():
    plans = plan_stock_location_links([sc()], [loc("sloc_1")])
    assert plans == [{
        "sales_channel_id": "sc_1",
        "sales_channel_name": "Default channel",
        "needs_link": True,
        "suggested_location_id": "sloc_1",
    }]


def test_explicit_default_location_wins_even_with_multiple_available():
    plans = plan_stock_location_links([sc()], [loc("sloc_1"), loc("sloc_2")], default_location_id="sloc_2")
    assert plans[0]["suggested_location_id"] == "sloc_2"


def test_multiple_channels_each_get_their_own_plan():
    plans = plan_stock_location_links(
        [sc(id="sc_1", stock_locations=[{"id": "sloc_1"}]), sc(id="sc_2", stock_locations=[])],
        [loc("sloc_1")],
    )
    assert plans[0]["needs_link"] is False
    assert plans[1]["needs_link"] is True
    assert plans[1]["suggested_location_id"] == "sloc_1"


def test_channel_with_zero_locations_and_no_locations_at_all_is_flagged():
    plans = plan_stock_location_links([sc()], [])
    assert plans[0]["needs_link"] is True
    assert plans[0]["suggested_location_id"] is None
