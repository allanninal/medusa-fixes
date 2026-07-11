"""Find Medusa v2 fulfillments that cannot cancel because their inventory
location level has already gone negative.

cancelFulfillmentWorkflow restores stock on the location level tied to a
fulfillment's line items. If that level's available stock (stocked_quantity
minus reserved_quantity) is already negative, from an earlier oversell, a
direct external write, or a drifted reservation, the restore step can fail
or leave the level worse off, so the fulfillment is stuck: neither canceled
nor usable. This script only reports blocked fulfillments. It never writes
a location level and never calls the cancel route. Safe to run again and
again.

Guide: https://www.allanninal.dev/medusa/cancel-fulfillment-negative-stock/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_blocked_cancels")

BASE_URL = os.environ["MEDUSA_BACKEND_URL"].rstrip("/")
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def admin_get(token, path, params=None):
    r = requests.get(
        f"{BASE_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def is_cancel_blocked_by_negative_stock(fulfillment, location_level):
    """Pure decision function. No network calls.

    A fulfillment cancel is blocked when the fulfillment is still active
    (not already canceled) and the inventory location level it depends on
    already has negative available stock (stocked_quantity - reserved_quantity).
    """
    if fulfillment.get("canceled_at"):
        return False
    if location_level is None:
        return False
    stocked = location_level.get("stocked_quantity")
    reserved = location_level.get("reserved_quantity")
    if stocked is None or reserved is None:
        return False
    available = stocked - reserved
    return available < 0


def fulfillment_inventory_refs(fulfillment):
    """Yield (inventory_item_id, location_id) pairs for a fulfillment's items."""
    location_id = fulfillment.get("location_id")
    for item in (fulfillment.get("items") or []):
        inventory_item_id = item.get("inventory_item_id")
        if inventory_item_id and location_id:
            yield inventory_item_id, location_id


def active_fulfillments(token):
    offset = 0
    limit = 50
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,display_id,*fulfillments,*fulfillments.items",
            "limit": limit,
            "offset": offset,
        })
        for order in data["orders"]:
            for f in (order.get("fulfillments") or []):
                if f.get("canceled_at"):
                    continue
                yield order, f
        offset += limit
        if offset >= data["count"]:
            return


def location_level_for(token, inventory_item_id, location_id):
    data = admin_get(token, f"/admin/inventory-items/{inventory_item_id}/location-levels", {
        "location_id": location_id,
    })
    levels = data.get("inventory_item", {}).get("location_levels", [])
    for lvl in levels:
        if lvl.get("location_id") == location_id:
            return lvl
    return None


def run():
    token = get_token()
    blocked = []
    for order, fulfillment in active_fulfillments(token):
        for inventory_item_id, location_id in fulfillment_inventory_refs(fulfillment):
            level = location_level_for(token, inventory_item_id, location_id)
            if is_cancel_blocked_by_negative_stock(fulfillment, level):
                blocked.append({
                    "order_id": order["id"],
                    "display_id": order.get("display_id"),
                    "fulfillment_id": fulfillment["id"],
                    "inventory_item_id": inventory_item_id,
                    "location_id": location_id,
                    "stocked_quantity": level["stocked_quantity"],
                    "reserved_quantity": level["reserved_quantity"],
                })
                log.warning(
                    "Order %s fulfillment %s blocked. Location %s available=%s.",
                    order.get("display_id"), fulfillment["id"], location_id,
                    level["stocked_quantity"] - level["reserved_quantity"],
                )
    log.info("Done. %d fulfillment(s) blocked by negative stock. %s",
              len(blocked), "(dry run, report only)" if DRY_RUN else "(report only, no writes made)")
    return blocked


if __name__ == "__main__":
    run()
