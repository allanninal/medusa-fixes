"""Find Medusa multi-part product location levels where reserved_quantity
has drifted from the live reservations, typically negative, because
allocate-items and fulfillment disagreed on the required_quantity multiplier.
Flags and reports by default. Only resyncs reserved_quantity to the computed
live sum when DRY_RUN is false and an operator has confirmed. Safe to run
again and again.

Guide: https://www.allanninal.dev/medusa/negative-reserved-quantity-bundles/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resync_negative_reserved")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRM_RESYNC = os.environ.get("CONFIRM_RESYNC", "false").lower() == "true"

PRODUCT_FIELDS = (
    "id,title,variants.id,variants.title,*variants.inventory_items,"
    "variants.inventory_items.required_quantity"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_multipart_variants(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/products",
            params={"fields": PRODUCT_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            for variant in product.get("variants", []):
                items = variant.get("inventory_items") or []
                if len(items) == 1 and items[0].get("required_quantity", 1) > 1:
                    out.append({
                        "product": product["title"],
                        "variant": variant,
                        "inventory_item": items[0],
                    })
        offset += limit
        if offset >= body["count"]:
            return out


def list_reservations(token, inventory_item_id, location_id):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/reservations",
            params={
                "inventory_item_id": inventory_item_id,
                "location_id": location_id,
                "limit": limit,
                "offset": offset,
            },
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["reservations"])
        offset += limit
        if offset >= body["count"]:
            return out


def get_location_levels(token, inventory_item_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["inventory_item"]["location_levels"]


def has_in_flight_order(token, inventory_item_id):
    """Skip a row if any reservation for it still points at an order still
    in progress. A minimal, conservative check: any reservation missing a
    line_item_id is treated as detached and left alone, since we cannot
    confirm it is safe."""
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/reservations",
        params={"inventory_item_id": inventory_item_id, "limit": 1},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    reservations = r.json()["reservations"]
    return any(not res.get("line_item_id") for res in reservations)


def compute_reserved_quantity_drift(stored_reserved_quantity, live_reservations):
    """Pure: no I/O. live_reservations is a list of {quantity: number, ...}.

    computedReserved sums quantity across liveReservations.
    drift = storedReservedQuantity - computedReserved.
    isNegativeAnomaly = storedReservedQuantity < 0.
    needsResync = isNegativeAnomaly or drift != 0.
    """
    computed_reserved = sum(r["quantity"] for r in live_reservations)
    drift = stored_reserved_quantity - computed_reserved
    is_negative_anomaly = stored_reserved_quantity < 0
    needs_resync = is_negative_anomaly or drift != 0
    return {
        "computedReserved": computed_reserved,
        "drift": drift,
        "isNegativeAnomaly": is_negative_anomaly,
        "needsResync": needs_resync,
    }


def resync_location_level(token, inventory_item_id, location_id, computed_reserved):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/inventory-items/{inventory_item_id}/location-levels/{location_id}",
        json={"reserved_quantity": computed_reserved},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    variants = list_multipart_variants(token)

    flagged = 0
    resynced = 0
    for entry in variants:
        inventory_item_id = entry["inventory_item"]["id"]
        levels = get_location_levels(token, inventory_item_id)
        for level in levels:
            location_id = level["location_id"]
            live_reservations = list_reservations(token, inventory_item_id, location_id)
            decision = compute_reserved_quantity_drift(level["reserved_quantity"], live_reservations)
            if not decision["needsResync"]:
                continue

            flagged += 1
            log.warning(
                "Product %s variant %s, item %s at location %s: stored=%s live_sum=%s "
                "drift=%s negative=%s",
                entry["product"], entry["variant"]["title"], inventory_item_id, location_id,
                level["reserved_quantity"], decision["computedReserved"],
                decision["drift"], decision["isNegativeAnomaly"],
            )

            if DRY_RUN or not CONFIRM_RESYNC:
                continue

            if has_in_flight_order(token, inventory_item_id):
                log.info("Skipping item %s at location %s, an order or fulfillment looks in flight.",
                          inventory_item_id, location_id)
                continue

            before = level["reserved_quantity"]
            resync_location_level(token, inventory_item_id, location_id, decision["computedReserved"])
            resynced += 1
            log.info("Resynced item %s at location %s. before=%s after=%s",
                      inventory_item_id, location_id, before, decision["computedReserved"])

    if flagged == 0:
        log.info("No drifted reserved_quantity rows found across %d multi-part variant(s).", len(variants))
        return

    if DRY_RUN or not CONFIRM_RESYNC:
        log.info("Done. %d row(s) flagged. Set DRY_RUN=false and CONFIRM_RESYNC=true to resync.", flagged)
    else:
        log.info("Done. %d row(s) flagged, %d resynced.", flagged, resynced)


if __name__ == "__main__":
    run()
