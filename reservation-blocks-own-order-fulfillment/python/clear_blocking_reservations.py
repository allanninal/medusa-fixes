"""Clear Medusa reservations that block fulfillment of their own order.

Medusa v2 computes an inventory level's available quantity as stocked_quantity
minus reserved_quantity, and the admin fulfillment checks gate on that number
being above zero. They never subtract out the reservation belonging to the
order being fulfilled, so once reserved_quantity reaches stocked_quantity on
the last unit sold, the very order that holds the reservation is told there is
zero available. This is worse when reservations are orphaned: left behind
after an order is canceled or archived, or after a fulfillment bug fails to
delete them. This scans reservations, resolves each one's order, and deletes
only the ones confirmed orphaned. Anything tied to an open order is left
alone and, if stuck, reported for manual review.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/reservation-blocks-own-order-fulfillment/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_blocking_reservations")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORPHAN_ORDER_STATUSES = {"canceled", "archived"}
ALREADY_FULFILLED_STATUSES = {"fulfilled", "shipped", "delivered"}
ORPHAN_OUTCOMES = {"orphan_canceled_order", "orphan_missing_order", "orphan_already_fulfilled"}


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


def classify_reservation(reservation, order_info, levels):
    """Pure decision function. No I/O.

    reservation: {"id": str, "line_item_id": str | None, "quantity": int, "location_id": str}
    order_info: {"exists": bool, "status": str | None, "fulfillment_status": str | None} | None
    levels: [{"location_id": str, "stocked_quantity": int, "reserved_quantity": int}, ...]

    Returns "keep" | "orphan_canceled_order" | "orphan_missing_order"
          | "orphan_already_fulfilled" | "manual_keep".

    Decision logic:
      1. No line_item_id -> manual/custom reservation, never touched -> "manual_keep"
      2. line_item_id set but order_info is None or order does not exist
         (order/line item hard-deleted) -> "orphan_missing_order"
      3. order_info.status is "canceled" or "archived" -> "orphan_canceled_order"
      4. order_info.fulfillment_status in {"fulfilled", "shipped", "delivered"}
         (fulfillment should have zeroed and deleted this reservation already)
         -> "orphan_already_fulfilled"
      5. Otherwise the reservation legitimately backs an open, unfulfilled order
         -> "keep"

    A caller then filters the location's level entry (stocked_quantity == reserved_quantity)
    to confirm this reservation is part of a fully exhausted, blocking level before repair.
    """
    if not reservation.get("line_item_id"):
        return "manual_keep"

    if order_info is None or not order_info.get("exists"):
        return "orphan_missing_order"

    if order_info.get("status") in ORPHAN_ORDER_STATUSES:
        return "orphan_canceled_order"

    if order_info.get("fulfillment_status") in ALREADY_FULFILLED_STATUSES:
        return "orphan_already_fulfilled"

    return "keep"


def list_reservations(token):
    reservations = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/reservations", {
            "fields": "id,quantity,line_item_id,inventory_item_id,location_id,created_at,*line_item.order",
            "limit": limit,
            "offset": offset,
        })
        reservations.extend(data["reservations"])
        offset += limit
        if offset >= data["count"]:
            return reservations


def resolve_order_info(reservation):
    """Turns the expanded *line_item.order payload into order_info, or None if missing."""
    line_item = reservation.get("line_item")
    if not line_item:
        return None
    order = line_item.get("order")
    if not order:
        return None
    return {
        "exists": True,
        "status": order.get("status"),
        "fulfillment_status": order.get("fulfillment_status"),
    }


def get_location_levels(token, inventory_item_id):
    data = admin_get(token, f"/admin/inventory-items/{inventory_item_id}/location-levels")
    return data.get("inventory_levels") or []


def find_level(levels, location_id):
    for level in levels:
        if level["location_id"] == location_id:
            return level
    return None


def run():
    token = get_admin_token()
    reservations = list_reservations(token)

    cleared = 0
    flagged_for_review = 0
    for reservation in reservations:
        if not reservation.get("line_item_id"):
            continue  # manual_keep, never touched

        order_info = resolve_order_info(reservation)
        levels = get_location_levels(token, reservation["inventory_item_id"])
        outcome = classify_reservation(reservation, order_info, levels)

        if outcome == "keep":
            level = find_level(levels, reservation["location_id"])
            if level and level["reserved_quantity"] == level["stocked_quantity"]:
                order_id = (reservation.get("line_item") or {}).get("order", {}).get("id")
                log.warning(
                    "Order %s: reservation %s keeps reserved_quantity == stocked_quantity "
                    "at location %s. Flagging for manual review, not touching stock or fulfillment.",
                    order_id, reservation["id"], reservation["location_id"],
                )
                flagged_for_review += 1
            continue

        if outcome not in ORPHAN_OUTCOMES:
            continue

        level = find_level(levels, reservation["location_id"])
        before_reserved = level["reserved_quantity"] if level else None
        stocked = level["stocked_quantity"] if level else None
        after_reserved = (before_reserved - reservation["quantity"]) if before_reserved is not None else None

        log.warning(
            "Reservation %s classified as %s. inventory_item_id=%s location_id=%s quantity=%s "
            "reserved_quantity %s -> %s (stocked_quantity=%s). %s",
            reservation["id"], outcome, reservation["inventory_item_id"], reservation["location_id"],
            reservation["quantity"], before_reserved, after_reserved, stocked,
            "Would delete" if DRY_RUN else "Deleting",
        )

        if not DRY_RUN:
            admin_delete(token, f"/admin/reservations/{reservation['id']}")

        cleared += 1

    log.info(
        "Done. %d orphaned reservation(s) %s. %d order(s) flagged for manual review.",
        cleared, "to clear" if DRY_RUN else "cleared", flagged_for_review,
    )


if __name__ == "__main__":
    run()
