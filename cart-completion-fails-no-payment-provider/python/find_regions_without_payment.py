"""Find Medusa regions that cannot complete a cart because of a payment provider gap, safely.

Completing a cart creates or reuses a payment_collection and asks the region's
linked payment providers to open a payment session. A provider only shows up
for a region when it is registered in medusa-config, linked to the region in
the Admin, and able to authenticate with its own credentials. A merchant can
set up a region with the right currency and countries and never link a
payment provider, or link one that is not actually registered, or link one
whose credentials are invalid. In every case the cart builds fine and only
fails when checkout tries to complete.

This script reports every region missing a working payment provider. It does
not link a payment provider automatically, since that is a business and
compliance decision tied to currency, licensing, and the merchant's account
with that provider. Run once, or on a schedule.

Guide: https://www.allanninal.dev/medusa/cart-completion-fails-no-payment-provider/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_regions_without_payment")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Only used if an operator explicitly opts into the guarded repair path.
TARGET_PROVIDER_ID = os.environ.get("TARGET_PROVIDER_ID", "").strip() or None


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
        params={"fields": "id,name,currency_code,*payment_providers"},
        timeout=30,
    )
    r.raise_for_status()
    regions = []
    for region in r.json()["regions"]:
        regions.append({
            "id": region["id"],
            "name": region.get("name"),
            "linkedProviderIds": [p["id"] for p in region.get("payment_providers", []) or []],
        })
    return regions


def get_enabled_provider_ids(token, region_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/payment-providers",
        headers={"Authorization": f"Bearer {token}"},
        params={"region_id": region_id},
        timeout=30,
    )
    r.raise_for_status()
    return {p["id"] for p in r.json().get("payment_providers", [])}


def find_regions_without_working_payment(regions_with_enabled):
    """Pure decision function. No I/O.

    regions_with_enabled: [{"id": str, "name": str, "linkedProviderIds": [str],
                             "enabledProviderIds": [str]}, ...]

    Returns a list of {"regionId": str, "regionName": str, "reason": str} for
    every region that has no linked payment provider, or whose linked
    providers are all missing from the enabled set. Covered regions are
    omitted.
    """
    results = []
    for region in regions_with_enabled:
        linked = region.get("linkedProviderIds") or []
        enabled = set(region.get("enabledProviderIds") or [])

        if not linked:
            results.append({
                "regionId": region["id"],
                "regionName": region.get("name"),
                "reason": "no_provider_linked",
            })
            continue

        if not any(pid in enabled for pid in linked):
            results.append({
                "regionId": region["id"],
                "regionName": region.get("name"),
                "reason": "linked_provider_not_enabled",
            })
    return results


def print_planned_repair(gap):
    log.info(
        "  [DRY RUN] would POST /admin/regions/%s {payment_providers: ['%s']}",
        gap["regionId"], TARGET_PROVIDER_ID,
    )


def apply_repair(token, gap):
    r = requests.post(
        f"{BACKEND_URL}/admin/regions/{gap['regionId']}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"payment_providers": [TARGET_PROVIDER_ID]},
        timeout=30,
    )
    r.raise_for_status()


def verify_region_has_provider(token, region_id, provider_id):
    enabled = get_enabled_provider_ids(token, region_id)
    return provider_id in enabled


def run():
    token = get_admin_token()
    regions = get_regions(token)

    regions_with_enabled = []
    for region in regions:
        enabled_ids = get_enabled_provider_ids(token, region["id"])
        regions_with_enabled.append({**region, "enabledProviderIds": list(enabled_ids)})

    gaps = find_regions_without_working_payment(regions_with_enabled)

    if not gaps:
        log.info("No gaps found. Every region has at least one working payment provider.")
        return

    for gap in gaps:
        log.info(
            "Gap: region=%s (%s) reason=%s",
            gap["regionName"], gap["regionId"], gap["reason"],
        )
        if TARGET_PROVIDER_ID:
            print_planned_repair(gap)
            if not DRY_RUN:
                apply_repair(token, gap)
                ok = verify_region_has_provider(token, gap["regionId"], TARGET_PROVIDER_ID)
                log.info("  Applied. Re-verified provider is enabled: %s", ok)

    log.info("Done. %d region(s) missing a working payment provider.", len(gaps))


if __name__ == "__main__":
    run()
