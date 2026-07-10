from find_regions_without_payment import find_regions_without_working_payment


def region(**over):
    base = {
        "id": "reg_1",
        "name": "Europe",
        "linkedProviderIds": ["pp_stripe_stripe"],
        "enabledProviderIds": ["pp_stripe_stripe"],
    }
    base.update(over)
    return base


def test_region_with_working_provider_is_covered():
    gaps = find_regions_without_working_payment([region()])
    assert gaps == []


def test_region_with_no_linked_provider_is_reported():
    gaps = find_regions_without_working_payment([region(linkedProviderIds=[])])
    assert gaps == [{"regionId": "reg_1", "regionName": "Europe", "reason": "no_provider_linked"}]


def test_region_with_linked_provider_not_enabled_is_reported():
    gaps = find_regions_without_working_payment(
        [region(linkedProviderIds=["pp_stripe_stripe"], enabledProviderIds=[])]
    )
    assert gaps == [{"regionId": "reg_1", "regionName": "Europe", "reason": "linked_provider_not_enabled"}]


def test_region_with_one_of_several_providers_working_is_covered():
    gaps = find_regions_without_working_payment(
        [region(linkedProviderIds=["pp_stripe_stripe", "pp_manual_manual"], enabledProviderIds=["pp_manual_manual"])]
    )
    assert gaps == []


def test_multiple_regions_each_get_their_own_verdict():
    regions = [
        region(id="reg_1", name="Europe"),
        region(id="reg_2", name="Asia", linkedProviderIds=[], enabledProviderIds=[]),
    ]
    gaps = find_regions_without_working_payment(regions)
    assert gaps == [{"regionId": "reg_2", "regionName": "Asia", "reason": "no_provider_linked"}]


def test_missing_keys_default_to_no_provider_linked():
    gaps = find_regions_without_working_payment([{"id": "reg_3", "name": "Oceania"}])
    assert gaps == [{"regionId": "reg_3", "regionName": "Oceania", "reason": "no_provider_linked"}]
