from find_uncovered_regions import find_uncovered_regions


def region(**over):
    base = {"id": "reg_1", "countryCodes": ["us"], "salesChannelIds": ["sc_1"]}
    base.update(over)
    return base


def geo_zone(country_code, zone_type="country"):
    return {"type": zone_type, "countryCode": country_code}


def option(id_="so_1", rules=None):
    return {"id": id_, "rules": rules or []}


def loc(sales_channel_ids, service_zones):
    return {
        "id": "sloc_1",
        "salesChannelIds": sales_channel_ids,
        "fulfillmentSets": [{"serviceZones": service_zones}],
    }


def test_country_with_matching_geo_zone_and_options_is_covered():
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": [option()]}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == []


def test_country_with_no_geo_zone_match_is_reported():
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("ca")], "shippingOptions": [option()]}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == [{"salesChannelId": "sc_1", "countryCode": "us", "reason": "no_geo_zone_match"}]


def test_matched_zone_with_no_shipping_options_is_reported():
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": []}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == [{"salesChannelId": "sc_1", "countryCode": "us", "reason": "zone_matched_no_shipping_options"}]


def test_matched_zone_where_all_options_excluded_by_subtotal_rule_is_reported():
    excluded_option = option(rules=[{"attribute": "cart.subtotal", "operator": "gte", "value": 10000}])
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": [excluded_option]}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == [{"salesChannelId": "sc_1", "countryCode": "us", "reason": "zone_matched_no_shipping_options"}]


def test_stock_location_not_linked_to_sales_channel_is_ignored():
    locations = [loc(["sc_other"], [{"geoZones": [geo_zone("us")], "shippingOptions": [option()]}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == [{"salesChannelId": "sc_1", "countryCode": "us", "reason": "no_geo_zone_match"}]


def test_multiple_countries_each_get_their_own_verdict():
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": [option()]}])]
    gaps = find_uncovered_regions([region(countryCodes=["us", "ca"])], locations)
    assert gaps == [{"salesChannelId": "sc_1", "countryCode": "ca", "reason": "no_geo_zone_match"}]


def test_zone_with_non_subtotal_rule_is_still_usable():
    non_blocking_option = option(rules=[{"attribute": "customer.group", "operator": "eq", "value": "wholesale"}])
    locations = [loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": [non_blocking_option]}])]
    gaps = find_uncovered_regions([region()], locations)
    assert gaps == []


def test_multiple_sales_channels_are_evaluated_independently():
    locations = [
        loc(["sc_1"], [{"geoZones": [geo_zone("us")], "shippingOptions": [option()]}]),
        loc(["sc_2"], [{"geoZones": [geo_zone("ca")], "shippingOptions": [option()]}]),
    ]
    regions = [region(id="reg_1", countryCodes=["us"], salesChannelIds=["sc_1", "sc_2"])]
    gaps = find_uncovered_regions(regions, locations)
    assert gaps == [{"salesChannelId": "sc_2", "countryCode": "us", "reason": "no_geo_zone_match"}]
