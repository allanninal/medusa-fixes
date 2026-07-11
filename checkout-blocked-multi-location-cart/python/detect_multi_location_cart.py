"""Detect Medusa v2 carts stuck at checkout because their items are stocked
across two or more stock locations, a known upstream bug (medusajs/medusa#10561).

The confirm-inventory preparation step, prepare-confirm-inventory-input.ts, merges
every line item's valid stock locations into one flattened list instead of keeping
each item's valid locations scoped to itself. The reserve-inventory step then picks
the first location in that merged list and tries to reserve every item there, so an
item only stocked at a different location fails to reserve, even though the channel
has enough total stock. This lists a cart's items, computes each item's own valid
locations from real per-location stock, and flags the cart when no single location
covers every item, though each item has stock somewhere. Auto-repair is unsafe, since
Medusa v2 has no supported endpoint to force per-item reservation at cart completion,
so the only write here is an optional, DRY_RUN-guarded manual reservation per item at
its own correct location, meant as a one-off mitigation while you upgrade past the bug.

Guide: https://www.allanninal.dev/medusa/checkout-blocked-multi-location-cart/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_multi_location_cart")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
CART_ID = os.environ.get("CART_ID", "").strip() or None
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_channel_location_ids(token, sales_channel_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/sales-channels/{sales_channel_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*stock_locations"},
        timeout=30,
    )
    r.raise_for_status()
    locations = r.json()["sales_channel"]["stock_locations"]
    return [loc["id"] for loc in locations]


def get_cart(token, cart_id):
    r = requests.get(
        f"{BACKEND_URL}/store/carts/{cart_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,sales_channel_id,*items,items.variant"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def get_variant_inventory_item_id(token, product_id, variant_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/products/{product_id}/variants/{variant_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*inventory_items,inventory_items.inventory.id"},
        timeout=30,
    )
    r.raise_for_status()
    items = r.json()["variant"]["inventory_items"]
    return items[0]["inventory"]["id"] if items else None


def get_location_levels(token, inventory_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "location_id,stocked_quantity,reserved_quantity"},
        timeout=30,
    )
    r.raise_for_status()
    levels = r.json()["inventory_levels"]
    return [
        {
            "locationId": lvl["location_id"],
            "stockedQuantity": lvl["stocked_quantity"],
            "reservedQuantity": lvl["reserved_quantity"],
        }
        for lvl in levels
    ]


def has_reservation(token, line_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/reservations",
        headers={"Authorization": f"Bearer {token}"},
        params={"line_item_id": line_item_id},
        timeout=30,
    )
    r.raise_for_status()
    return len(r.json().get("reservations", [])) > 0


def create_reservation(token, line_item_id, inventory_item_id, location_id, quantity):
    r = requests.post(
        f"{BACKEND_URL}/admin/reservations",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "line_item_id": line_item_id,
            "inventory_item_id": inventory_item_id,
            "location_id": location_id,
            "quantity": quantity,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def resolve_item_locations(items, levels_by_inventory_item, channel_location_ids):
    """Pure decision function. No I/O.

    items: [{"lineItemId": str, "inventoryItemId": str, "requiredQty": int}, ...]
    levels_by_inventory_item: {inventoryItemId: [{"locationId": str, "stockedQuantity": int,
                                                   "reservedQuantity": int}, ...]}
    channel_location_ids: [str, ...]

    Returns [{"lineItemId": str, "validLocationIds": [str, ...]}, ...], one entry per
    item, in the same order, where validLocationIds is every channel-linked location
    that has enough available stock (stockedQuantity - reservedQuantity) for that item.
    """
    channel_set = set(channel_location_ids)
    results = []
    for item in items:
        levels = levels_by_inventory_item.get(item["inventoryItemId"], [])
        valid_location_ids = [
            lvl["locationId"]
            for lvl in levels
            if lvl["locationId"] in channel_set
            and (lvl["stockedQuantity"] - lvl["reservedQuantity"]) >= item["requiredQty"]
        ]
        results.append({"lineItemId": item["lineItemId"], "validLocationIds": valid_location_ids})
    return results


def is_affected_cart(item_locations):
    """Pure decision function. No I/O.

    A cart is a stuck-at-reservation candidate when every item has at least one valid
    location of its own, but no single location is valid for every item at once, the
    signature of medusajs/medusa#10561. An empty cart, or a cart where some item has
    zero valid locations (a real out-of-stock case, not this bug), is not affected.
    """
    if not item_locations:
        return False
    if any(len(entry["validLocationIds"]) == 0 for entry in item_locations):
        return False
    shared = set(item_locations[0]["validLocationIds"])
    for entry in item_locations[1:]:
        shared &= set(entry["validLocationIds"])
    return len(shared) == 0


def run():
    if not CART_ID:
        raise RuntimeError("Set CART_ID to the cart you want to check.")

    token = get_admin_token()
    cart = get_cart(token, CART_ID)
    channel_location_ids = get_channel_location_ids(token, cart["sales_channel_id"])

    items = []
    inventory_item_by_line_item = {}
    for line_item in cart["items"]:
        variant = line_item["variant"]
        inventory_item_id = get_variant_inventory_item_id(token, variant["product_id"], variant["id"])
        if not inventory_item_id:
            continue
        items.append({
            "lineItemId": line_item["id"],
            "inventoryItemId": inventory_item_id,
            "requiredQty": line_item["quantity"],
        })
        inventory_item_by_line_item[line_item["id"]] = inventory_item_id

    levels_by_inventory_item = {
        item["inventoryItemId"]: get_location_levels(token, item["inventoryItemId"])
        for item in items
    }

    item_locations = resolve_item_locations(items, levels_by_inventory_item, channel_location_ids)
    affected = is_affected_cart(item_locations)

    if not affected:
        log.info("Cart %s: not affected. Items share a common valid location, or one has none at all.", CART_ID)
        return

    unreserved = [entry for entry in item_locations if not has_reservation(token, entry["lineItemId"])]
    log.warning(
        "Cart %s is affected by medusajs/medusa#10561: no shared location across items, "
        "%d item(s) missing a reservation.",
        CART_ID, len(unreserved),
    )
    for entry in item_locations:
        log.info("  line item %s valid locations: %s", entry["lineItemId"], entry["validLocationIds"])

    for entry in unreserved:
        location_id = entry["validLocationIds"][0]
        inventory_item_id = inventory_item_by_line_item[entry["lineItemId"]]
        required_qty = next(i["requiredQty"] for i in items if i["lineItemId"] == entry["lineItemId"])
        payload = {
            "line_item_id": entry["lineItemId"],
            "inventory_item_id": inventory_item_id,
            "location_id": location_id,
            "quantity": required_qty,
        }
        log.info("%s reservation: %s", "Would create" if DRY_RUN else "Creating", payload)
        if not DRY_RUN:
            create_reservation(token, **{
                "line_item_id": payload["line_item_id"],
                "inventory_item_id": payload["inventory_item_id"],
                "location_id": payload["location_id"],
                "quantity": payload["quantity"],
            })

    log.info("Done. %d item(s) %s a manual reservation.", len(unreserved), "would need" if DRY_RUN else "given")


if __name__ == "__main__":
    run()
