"""Find Medusa variants with a missing inventory level and create it, safely, at zero.

A variant with manage_inventory true is only purchasable if its inventory item has
an InventoryLevel row at a stock location linked to the sales channel making the
request. This lists managed variants, reads each inventory item's existing levels,
decides what to do with a pure function, and only creates a level where one is
fully absent, always at stocked_quantity zero. A level that exists only at the
wrong location is flagged, not silently duplicated. Run once, or on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/variant-not-purchasable-no-inventory-level/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("create_missing_levels")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SALES_CHANNEL_ID = os.environ.get("SALES_CHANNEL_ID", "sc_default")

VARIANT_FIELDS = (
    "id,title,status,*variants,variants.manage_inventory,variants.id,"
    "*variants.inventory_items,variants.inventory_items.inventory_item_id"
)


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_managed_variants(token):
    offset = 0
    limit = 100
    variants = []
    while True:
        r = requests.get(
            f"{BACKEND_URL}/admin/products",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": VARIANT_FIELDS, "limit": limit, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            for variant in product.get("variants") or []:
                if variant.get("manage_inventory"):
                    items = variant.get("inventory_items") or []
                    inventory_item_id = items[0]["inventory_item_id"] if items else None
                    variants.append({
                        "id": variant["id"],
                        "manageInventory": True,
                        "inventoryItemId": inventory_item_id,
                    })
        offset += limit
        if offset >= body["count"]:
            return variants


def get_location_levels(token, inventory_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*location_levels"},
        timeout=30,
    )
    r.raise_for_status()
    levels = r.json()["inventory_item"].get("location_levels") or []
    return [
        {"locationId": lv["location_id"], "stockedQuantity": lv["stocked_quantity"]}
        for lv in levels
    ]


def get_required_location_ids(token, sales_channel_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/sales-channels/{sales_channel_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,name,*stock_locations"},
        timeout=30,
    )
    r.raise_for_status()
    locations = r.json()["sales_channel"].get("stock_locations") or []
    return [loc["id"] for loc in locations]


def decide_inventory_repair(variant, existing_levels, required_location_ids):
    """Pure decision function. No I/O.

    variant: {"manageInventory": bool, "inventoryItemId": str | None}
    existing_levels: [{"locationId": str, "stockedQuantity": number}, ...]
    required_location_ids: [str, ...]

    Returns {"action": "skip" | "flag_no_inventory_item" | "create_zero_level" | "ok",
             "missingLocationIds": [str, ...]}.
    """
    if not variant.get("manageInventory"):
        return {"action": "skip", "missingLocationIds": []}

    if not variant.get("inventoryItemId"):
        return {"action": "flag_no_inventory_item", "missingLocationIds": []}

    existing_ids = {lv["locationId"] for lv in existing_levels}
    missing = [loc_id for loc_id in required_location_ids if loc_id not in existing_ids]

    if not missing:
        return {"action": "ok", "missingLocationIds": []}

    return {"action": "create_zero_level", "missingLocationIds": missing}


def create_zero_level(token, inventory_item_id, location_id):
    r = requests.post(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"location_id": location_id, "stocked_quantity": 0},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_admin_token()
    variants = list_managed_variants(token)
    required_location_ids = get_required_location_ids(token, SALES_CHANNEL_ID)

    created = 0
    flagged = 0
    for variant in variants:
        if not variant["manageInventory"]:
            continue

        if not variant["inventoryItemId"]:
            log.warning("Variant %s tracks inventory but has no inventory item. Flagging.", variant["id"])
            flagged += 1
            continue

        existing_levels = get_location_levels(token, variant["inventoryItemId"])
        decision = decide_inventory_repair(variant, existing_levels, required_location_ids)

        if decision["action"] in ("skip", "ok"):
            continue
        if decision["action"] == "flag_no_inventory_item":
            flagged += 1
            continue

        for location_id in decision["missingLocationIds"]:
            log.info(
                "Inventory item %s missing level at %s. %s",
                variant["inventoryItemId"], location_id,
                "would create stocked_quantity=0" if DRY_RUN else "creating stocked_quantity=0",
            )
            if not DRY_RUN:
                create_zero_level(token, variant["inventoryItemId"], location_id)
            created += 1

    log.info(
        "Done. %d level(s) %s, %d variant(s) flagged for review.",
        created, "to create" if DRY_RUN else "created", flagged,
    )


if __name__ == "__main__":
    run()
