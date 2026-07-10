"""Find Medusa regions whose countries have no matching shipping coverage, safely.

Shipping availability for a cart is resolved by walking cart to sales channel
to stock location to FulfillmentSet to ServiceZone to GeoZone, and matching
the cart's shipping_address.country_code against a GeoZone. Regions control
checkout availability and currency, and are configured independently of
service zone geo zones, so a merchant can add a country to a Region without
ever adding a matching GeoZone to any ServiceZone, or without linking the
right stock location to the sales channel. That leaves the country's carts
with a zero length shipping_options array even though the region, product,
and pricing all look correct.

This script reports every uncovered (sales_channel, country) pair. It does
not create service zones, geo zones, or shipping options automatically,
since that is a business decision about which countries to actually ship
to, carrier rates, and tax nexus. Run once, or on a schedule. Safe to run
again and again.

Guide: https://www.allanninal.dev/medusa/no-shipping-option-for-the-cart/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_uncovered_regions")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Only used if an operator explicitly opts into the guarded repair path.
FULFILLMENT_SET_ID = os.environ.get("FULFILLMENT_SET_ID", "").strip() or None
SERVICE_ZONE_ID = os.environ.get("SERVICE_ZONE_ID", "").strip() or None
SHIPPING_PROFILE_ID = os.environ.get("SHIPPING_PROFILE_ID", "").strip() or None
PROVIDER_ID = os.environ.get("PROVIDER_ID", "").strip() or None


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_regions(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/regions",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,name,*countries"},
        timeout=30,
    )
    r.raise_for_status()
    regions = []
    for region in r.json()["regions"]:
        regions.append({
            "id": region["id"],
            "countryCodes": [c["iso_2"] for c in region.get("countries", []) if c.get("iso_2")],
            "salesChannelIds": [sc["id"] for sc in region.get("sales_channels", []) or []] or [region["id"]],
        })
    return regions


def get_stock_locations(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/stock-locations",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "fields": "id,name,*sales_channels,*fulfillment_sets,"
                      "*fulfillment_sets.service_zones,"
                      "*fulfillment_sets.service_zones.geo_zones,"
                      "*fulfillment_sets.service_zones.shipping_options",
        },
        timeout=30,
    )
    r.raise_for_status()
    locations = []
    for loc in r.json()["stock_locations"]:
        locations.append({
            "id": loc["id"],
            "salesChannelIds": [sc["id"] for sc in loc.get("sales_channels", []) or []],
            "fulfillmentSets": [
                {
                    "serviceZones": [
                        {
                            "geoZones": [
                                {"type": gz.get("type"), "countryCode": gz.get("country_code")}
                                for gz in zone.get("geo_zones", []) or []
                            ],
                            "shippingOptions": [
                                {"id": opt["id"], "rules": opt.get("rules", [])}
                                for opt in zone.get("shipping_options", []) or []
                            ],
                        }
                        for zone in fset.get("service_zones", []) or []
                    ]
                }
                for fset in loc.get("fulfillment_sets", []) or []
            ],
        })
    return locations


def find_uncovered_regions(regions, stock_locations):
    """Pure decision function. No I/O.

    regions: [{"id": str, "countryCodes": [str], "salesChannelIds": [str]}, ...]
    stock_locations: [{"id": str, "salesChannelIds": [str],
                        "fulfillmentSets": [{"serviceZones": [{"geoZones": [...], "shippingOptions": [...]}]}]}, ...]

    Returns a list of {"salesChannelId": str, "countryCode": str, "reason": str}
    for every (salesChannelId, countryCode) pair a region requires but that has
    no matching geo zone ("no_geo_zone_match"), or matches a service zone with
    no usable shipping option ("zone_matched_no_shipping_options"). Covered
    pairs are omitted from the result.
    """
    results = []
    for region in regions:
        for sales_channel_id in region.get("salesChannelIds", []):
            locations_for_channel = [
                loc for loc in stock_locations
                if sales_channel_id in loc.get("salesChannelIds", [])
            ]
            for country_code in region.get("countryCodes", []):
                matched_zone = None
                for loc in locations_for_channel:
                    for fset in loc.get("fulfillmentSets", []):
                        for zone in fset.get("serviceZones", []):
                            for gz in zone.get("geoZones", []):
                                if gz.get("type") == "country" and gz.get("countryCode") == country_code:
                                    matched_zone = zone
                                    break
                            if matched_zone:
                                break
                        if matched_zone:
                            break
                    if matched_zone:
                        break

                if matched_zone is None:
                    results.append({
                        "salesChannelId": sales_channel_id,
                        "countryCode": country_code,
                        "reason": "no_geo_zone_match",
                    })
                    continue

                options = matched_zone.get("shippingOptions", [])
                if not options or all(_excluded(opt) for opt in options):
                    results.append({
                        "salesChannelId": sales_channel_id,
                        "countryCode": country_code,
                        "reason": "zone_matched_no_shipping_options",
                    })
    return results


def _excluded(option):
    for rule in option.get("rules", []) or []:
        if rule.get("attribute") == "cart.subtotal" and rule.get("operator") in ("gt", "gte") \
                and isinstance(rule.get("value"), (int, float)) and rule["value"] > 0:
            return True
    return False


def print_planned_repair(gap):
    log.info(
        "  [DRY RUN] would POST /admin/fulfillment-sets/%s/service-zones/%s/geo-zones "
        "{type: 'country', country_code: '%s'}",
        FULFILLMENT_SET_ID, SERVICE_ZONE_ID, gap["countryCode"],
    )
    log.info(
        "  [DRY RUN] would POST /admin/shipping-options "
        "{service_zone_id: '%s', shipping_profile_id: '%s', provider_id: '%s', prices: [...]}",
        SERVICE_ZONE_ID, SHIPPING_PROFILE_ID, PROVIDER_ID,
    )


def apply_repair(token, gap):
    r = requests.post(
        f"{BACKEND_URL}/admin/fulfillment-sets/{FULFILLMENT_SET_ID}/service-zones/{SERVICE_ZONE_ID}/geo-zones",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"type": "country", "country_code": gap["countryCode"]},
        timeout=30,
    )
    r.raise_for_status()


def verify_cart_has_options(token, cart_id):
    r = requests.get(
        f"{BACKEND_URL}/store/shipping-options",
        headers={"Authorization": f"Bearer {token}"},
        params={"cart_id": cart_id},
        timeout=30,
    )
    r.raise_for_status()
    return len(r.json().get("shipping_options", [])) > 0


def run():
    token = get_admin_token()
    regions = get_regions(token)
    stock_locations = get_stock_locations(token)

    gaps = find_uncovered_regions(regions, stock_locations)

    if not gaps:
        log.info("No gaps found. Every region country has a matching service zone with usable shipping options.")
        return

    for gap in gaps:
        log.info(
            "Gap: sales_channel=%s country=%s reason=%s",
            gap["salesChannelId"], gap["countryCode"], gap["reason"],
        )
        can_repair = FULFILLMENT_SET_ID and SERVICE_ZONE_ID and SHIPPING_PROFILE_ID and PROVIDER_ID
        if can_repair:
            print_planned_repair(gap)
            if not DRY_RUN:
                apply_repair(token, gap)
                log.info("  Applied. Re-verify with a synthetic cart before trusting checkout.")

    log.info("Done. %d uncovered (sales_channel, country) pair(s) found.", len(gaps))


if __name__ == "__main__":
    run()
