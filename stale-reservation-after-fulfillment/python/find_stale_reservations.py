"""Find and delete Medusa inventory reservations left over after fulfillment.

Medusa v2 creates a ReservationItem linking an inventory_item_id, location_id,
and the order's line_item_id whenever a line item is purchased. The intended
lifecycle deletes that row once the line item is fulfilled, but the delete step
is not transactionally guaranteed. When a variant has multiple inventory items,
or the fulfillment and order completion handlers race or partially fail, the
reservation can survive an order that is already completed or canceled. This
lists closed orders, resolves the reservations tied to their line items, and
deletes only the ones whose order status and fulfillment status are both
terminal.
Run as a scheduled reconciler. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/stale-reservation-after-fulfillment/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_stale_reservations")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

TERMINAL_ORDER_STATUSES = {"completed", "canceled"}
TERMINAL_FULFILLMENT_STATUSES = {"fulfilled", "delivered", "canceled"}


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def admin_get(token, path, params=None):
    r = requests.get(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def admin_delete(token, path):
    r = requests.delete(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_stale_reservations(orders, reservations):
    """Pure decision function. No I/O.

    orders: [{"id": str, "status": str, "fulfillment_status": str, "items": [{"id": str}]}]
    reservations: [{"id": str, "line_item_id": str | None, "quantity": int, ...}]

    Builds a lookup from line_item_id to the order that owns it, then keeps a
    reservation only when that order's status is in TERMINAL_ORDER_STATUSES and
    its fulfillment_status is in TERMINAL_FULFILLMENT_STATUSES.

    Returns a list of {"reservation_id", "order_id", "line_item_id", "quantity"}.
    """
    line_item_to_order = {}
    for order in orders:
        for item in order.get("items") or []:
            line_item_to_order[item["id"]] = order

    stale = []
    for reservation in reservations:
        line_item_id = reservation.get("line_item_id")
        if not line_item_id:
            continue
        order = line_item_to_order.get(line_item_id)
        if order is None:
            continue
        if order.get("status") not in TERMINAL_ORDER_STATUSES:
            continue
        if order.get("fulfillment_status") not in TERMINAL_FULFILLMENT_STATUSES:
            continue
        stale.append({
            "reservation_id": reservation["id"],
            "order_id": order["id"],
            "line_item_id": line_item_id,
            "quantity": reservation["quantity"],
        })
    return stale


def chunk(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def list_closed_orders(token):
    orders = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/orders", {
            "status[]": ["completed", "canceled"],
            "fields": "id,display_id,status,fulfillment_status,*items",
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def list_reservations_for_line_items(token, line_item_ids):
    reservations = []
    for batch in chunk(line_item_ids, 100):
        if not batch:
            continue
        data = admin_get(token, "/admin/reservations", {
            "line_item_id[]": batch,
            "fields": "id,line_item_id,inventory_item_id,location_id,quantity,created_at",
            "limit": 200,
        })
        reservations.extend(data["reservations"])
    return reservations


def run():
    token = get_admin_token()
    orders = list_closed_orders(token)
    line_item_ids = [item["id"] for order in orders for item in (order.get("items") or [])]
    reservations = list_reservations_for_line_items(token, line_item_ids)

    matches = find_stale_reservations(orders, reservations)

    for match in matches:
        log.warning(
            "Stale reservation %s on order %s, line_item %s, quantity %s. %s",
            match["reservation_id"], match["order_id"], match["line_item_id"], match["quantity"],
            "Would delete" if DRY_RUN else "Deleting",
        )
        if not DRY_RUN:
            admin_delete(token, f"/admin/reservations/{match['reservation_id']}")

    log.info("Done. %d stale reservation(s) %s.", len(matches), "found" if DRY_RUN else "deleted")


if __name__ == "__main__":
    run()
