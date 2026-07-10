"""Find Medusa inventory levels where reserved quantity exceeds stocked
quantity (an oversold variant with negative available stock).
Never writes a location level without --confirm. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/oversold-variant-goes-negative/
"""
import os
import sys
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_oversold_inventory")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ITEM_FIELDS = "id,sku,*location_levels,*location_levels.location"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_inventory_items(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/inventory-items",
            params={"fields": ITEM_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["inventory_items"])
        offset += limit
        if offset >= body["count"]:
            return out


def open_reservations_total(token, inventory_item_id, location_id):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/reservations",
            params={
                "location_id": location_id,
                "inventory_item_id": inventory_item_id,
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
            break
    return sum(res["quantity"] for res in out)


def decide_inventory_repair(level, open_reservations_total_value):
    """Pure decision logic (no I/O).

    level: {inventoryItemId, locationId, stockedQuantity, reservedQuantity, allowBackorder}
    open_reservations_total_value: sum of quantity across open reservations for this
        inventory item and location, used as a floor for the proposed recount.

    Returns {isOversold, available, reason, proposedStockedQuantity}.
    Backorder-enabled variants are expected to go negative/zero by design, not a bug,
    so they are never flagged.
    """
    stocked = level["stockedQuantity"]
    reserved = level["reservedQuantity"]
    available = stocked - reserved

    is_oversold = (available < 0 or reserved > stocked) and not level["allowBackorder"]

    if not is_oversold:
        return {
            "isOversold": False,
            "available": available,
            "reason": "ok",
            "proposedStockedQuantity": None,
        }

    reason = "reserved_exceeds_stock" if reserved > stocked else "negative_available"
    # Guarantee available >= 0 without dropping below what open orders already reserved.
    proposed = max(stocked, open_reservations_total_value)
    return {
        "isOversold": True,
        "available": available,
        "reason": reason,
        "proposedStockedQuantity": proposed,
    }


def write_location_level(token, inventory_item_id, location_id, real_count):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/inventory-items/{inventory_item_id}/location-levels/{location_id}",
        json={"stocked_quantity": real_count},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    confirm = "--confirm" in sys.argv
    token = get_token()
    items = list_inventory_items(token)

    flagged = 0
    for item in items:
        for lvl in item.get("location_levels") or []:
            level = {
                "inventoryItemId": item["id"],
                "locationId": lvl["location_id"],
                "stockedQuantity": lvl["stocked_quantity"],
                "reservedQuantity": lvl["reserved_quantity"],
                "allowBackorder": bool(lvl.get("allow_backorder")),
            }
            reserved_total = open_reservations_total(token, level["inventoryItemId"], level["locationId"])
            decision = decide_inventory_repair(level, reserved_total)
            if not decision["isOversold"]:
                continue

            flagged += 1
            log.warning(
                "Inventory item %s (sku %s) at location %s: %s. stocked=%s reserved=%s "
                "available=%s proposed realCount=%s",
                item["id"], item.get("sku"), level["locationId"], decision["reason"],
                level["stockedQuantity"], level["reservedQuantity"],
                decision["available"], decision["proposedStockedQuantity"],
            )

            if not DRY_RUN and confirm:
                write_location_level(
                    token, level["inventoryItemId"], level["locationId"],
                    decision["proposedStockedQuantity"],
                )
                log.info("Wrote stocked_quantity=%s for item %s at location %s.",
                         decision["proposedStockedQuantity"], item["id"], level["locationId"])

    if flagged == 0:
        log.info("No oversold inventory levels found across %d item(s).", len(items))
        return

    if DRY_RUN or not confirm:
        log.info("Done. %d level(s) flagged. Re-run with DRY_RUN=false and --confirm to write.", flagged)
    else:
        log.info("Done. %d level(s) flagged and repaired.", flagged)


if __name__ == "__main__":
    run()
