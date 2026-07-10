"""Release Medusa reservations orphaned by abandoned or cancelled carts.

When stock is reserved for a cart, Medusa creates a ReservationItem linked to a
line_item_id, inventory_item_id, and location_id. There is no cart cancel workflow
that reliably deletes that reservation, and ReservationItem has no cart_id field to
join back to, so an abandoned, timed out, or manually voided cart leaves the row
behind. This lists reservations, resolves each line_item_id against real orders,
and deletes only the ones that are a true orphan or tied to a canceled order, after
an age gate so an in-flight checkout is never touched.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/stuck-reservations-after-cancelled-carts/
"""
import os
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("release_stuck_reservations")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
STALE_AFTER_HOURS = float(os.environ.get("STALE_AFTER_HOURS", "24"))
STALE_AFTER_MS = STALE_AFTER_HOURS * 3600 * 1000
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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


def classify_reservation(reservation, order_line_item_index, now, stale_after_ms):
    """Pure decision function. No I/O.

    reservation: {"id": str, "line_item_id": str | None, "created_at": str (ISO)}
    order_line_item_index: {line_item_id: {"orderId": str, "orderStatus": str}}
    now: datetime, timezone aware
    stale_after_ms: float

    Returns "keep" | "stale_orphan" | "stale_canceled_order".

    - "keep": there is no line_item_id, the reservation is younger than
      stale_after_ms, or the matched order's status is active (not "canceled").
    - "stale_orphan": line_item_id has no matching order at all (the cart was
      never completed into an order).
    - "stale_canceled_order": line_item_id matches an order whose status is
      "canceled".
    """
    line_item_id = reservation.get("line_item_id")
    if not line_item_id:
        return "keep"

    created_at = datetime.fromisoformat(reservation["created_at"].replace("Z", "+00:00"))
    age_ms = (now - created_at).total_seconds() * 1000
    if age_ms < stale_after_ms:
        return "keep"

    match = order_line_item_index.get(line_item_id)
    if match is None:
        return "stale_orphan"
    if match["orderStatus"] == "canceled":
        return "stale_canceled_order"
    return "keep"


def list_reservations(token):
    reservations = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/reservations", {
            "fields": "id,quantity,line_item_id,inventory_item_id,location_id,created_at,*inventory_item",
            "limit": limit,
            "offset": offset,
        })
        reservations.extend(data["reservations"])
        offset += limit
        if offset >= data["count"]:
            return reservations


def build_order_line_item_index(token):
    """Returns { line_item_id: {"orderId": str, "orderStatus": str} }."""
    index = {}
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,status,*items",
            "limit": limit,
            "offset": offset,
        })
        for order in data["orders"]:
            for item in order.get("items") or []:
                index[item["id"]] = {"orderId": order["id"], "orderStatus": order["status"]}
        offset += limit
        if offset >= data["count"]:
            return index


def get_location_level(token, inventory_item_id, location_id):
    data = admin_get(token, f"/admin/inventory-items/{inventory_item_id}/location-levels", {
        "location_id": location_id,
    })
    levels = data.get("inventory_levels") or []
    return levels[0] if levels else None


def run():
    token = get_admin_token()
    reservations = list_reservations(token)
    order_line_item_index = build_order_line_item_index(token)
    now = datetime.now(timezone.utc)

    released = 0
    for reservation in reservations:
        outcome = classify_reservation(reservation, order_line_item_index, now, STALE_AFTER_MS)
        if outcome == "keep":
            continue

        before = get_location_level(token, reservation["inventory_item_id"], reservation["location_id"])
        before_reserved = before.get("reserved_quantity") if before else None

        log.warning(
            "Reservation %s classified as %s. inventory_item_id=%s location_id=%s quantity=%s. %s",
            reservation["id"], outcome, reservation["inventory_item_id"], reservation["location_id"],
            reservation["quantity"], "Would delete" if DRY_RUN else "Deleting",
        )

        if not DRY_RUN:
            admin_delete(token, f"/admin/reservations/{reservation['id']}")
            after = get_location_level(token, reservation["inventory_item_id"], reservation["location_id"])
            after_reserved = after.get("reserved_quantity") if after else None
            expected = (before_reserved - reservation["quantity"]) if before_reserved is not None else None
            if expected is not None and after_reserved != expected:
                log.warning(
                    "  reserved_quantity did not drop as expected for %s: before=%s after=%s expected=%s",
                    reservation["inventory_item_id"], before_reserved, after_reserved, expected,
                )
            else:
                log.info("  reserved_quantity confirmed: before=%s after=%s", before_reserved, after_reserved)

        released += 1

    log.info("Done. %d reservation(s) %s.", released, "to release" if DRY_RUN else "released")


if __name__ == "__main__":
    run()
