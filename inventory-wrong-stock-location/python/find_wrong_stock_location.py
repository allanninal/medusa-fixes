"""Find Medusa orders whose reservation decremented stock at the wrong location.

A stock location's availability for a sale is supposed to be scoped by the
sales channel the order was placed through, using the SalesChannelLocation
link between the Stock Location and Sales Channel modules. A bug tracked as
medusajs/medusa issue 10658 meant the cart completion and order edit
workflows could collect every stock location tied to an inventory item
without filtering by the order's own sales channel, so a reservation could
land at a location that belongs to a different channel entirely. This walks
recent orders, resolves the expected location with a pure function, and
reports every mismatch. It never rewrites a reservation on its own; a
corrective plan is only logged, and only for orders whose items are not yet
fulfilled. Run once, or on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/inventory-wrong-stock-location/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_wrong_stock_location")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_LIMIT = int(os.environ.get("ORDER_LIMIT", "50"))


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_recent_orders(token, limit):
    r = requests.get(
        f"{BACKEND_URL}/admin/orders",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,display_id,sales_channel_id,*items,*items.variant", "limit": limit},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["orders"]


def get_sales_channel_location_ids(token, sales_channel_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/sales-channels/{sales_channel_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*stock_locations"},
        timeout=30,
    )
    r.raise_for_status()
    locations = r.json()["sales_channel"]["stock_locations"] or []
    return [loc["id"] for loc in locations]


def get_location_levels(token, inventory_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "location_id,stocked_quantity,reserved_quantity"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["inventory_levels"]


def get_reservations_for_line_item(token, line_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/reservations",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "line_item_id": line_item_id,
            "fields": "id,location_id,inventory_item_id,quantity,line_item_id",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["reservations"]


def pick_expected_location_id(location_levels, sales_channel_location_ids, actual_location_id):
    """Pure decision function. No I/O.

    location_levels: [{"location_id": str, "stocked_quantity": number}, ...]
    sales_channel_location_ids: [str, ...]
    actual_location_id: str

    Filters location_levels down to the ones whose location_id is in
    sales_channel_location_ids, picks the first match (or None if none are
    linked/stocked) as expected_location_id, and returns whether that expected
    location differs from actual_location_id.

    Returns {"expected_location_id": str | None, "is_mismatch": bool}.
    """
    linked_ids = set(sales_channel_location_ids)
    matches = [lvl for lvl in location_levels if lvl.get("location_id") in linked_ids]
    expected_location_id = matches[0]["location_id"] if matches else None
    is_mismatch = expected_location_id is not None and expected_location_id != actual_location_id
    return {"expected_location_id": expected_location_id, "is_mismatch": is_mismatch}


def item_is_fulfilled(item):
    return (item.get("fulfilled_quantity") or 0) > 0


def run():
    token = get_admin_token()
    orders = get_recent_orders(token, ORDER_LIMIT)

    channel_location_cache = {}
    flagged = 0
    corrected = 0

    for order in orders:
        sales_channel_id = order.get("sales_channel_id")
        if not sales_channel_id:
            continue
        if sales_channel_id not in channel_location_cache:
            channel_location_cache[sales_channel_id] = get_sales_channel_location_ids(token, sales_channel_id)
        linked_ids = channel_location_cache[sales_channel_id]

        for item in order.get("items") or []:
            variant = item.get("variant") or {}
            inventory_items = variant.get("inventory_items") or []
            for inv in inventory_items:
                inventory_item_id = (inv.get("inventory") or {}).get("id") or inv.get("inventory_item_id")
                if not inventory_item_id:
                    continue
                location_levels = get_location_levels(token, inventory_item_id)
                reservations = get_reservations_for_line_item(token, item["id"])
                for reservation in reservations:
                    decision = pick_expected_location_id(location_levels, linked_ids, reservation["location_id"])
                    if not decision["is_mismatch"]:
                        continue

                    flagged += 1
                    log.warning(
                        "Order %s: reservation %s used location %s, expected one linked to sales channel %s (%s)",
                        order.get("display_id"), reservation["id"], reservation["location_id"],
                        sales_channel_id, decision["expected_location_id"],
                    )

                    if item_is_fulfilled(item):
                        log.warning(
                            "Order %s: item already fulfilled, flagging for manual stock adjustment only",
                            order.get("display_id"),
                        )
                        continue

                    log.info(
                        "%s reservation %s: location %s -> %s",
                        "Would correct" if DRY_RUN else "Correcting",
                        reservation["id"], reservation["location_id"], decision["expected_location_id"],
                    )
                    if not DRY_RUN:
                        # Deliberately left as a logged plan. Recreating a reservation at the
                        # correct location is a destructive two-step write (delete then
                        # re-create) and should only run after an operator has confirmed the
                        # order is genuinely unfulfilled and the target location is correct.
                        log.warning(
                            "Order %s: DRY_RUN is off, but this script only reports. "
                            "Confirm manually, then delete reservation %s and recreate it "
                            "with location_id=%s before shipping.",
                            order.get("display_id"), reservation["id"], decision["expected_location_id"],
                        )
                    corrected += 1

    log.info("Done. %d mismatch(es) found, %d eligible for a guarded correction.", flagged, corrected)


if __name__ == "__main__":
    run()
