"""Trace Medusa reservations back to the orders they belong to.

Medusa v2 deliberately decouples the Inventory module from the Order module.
ReservationItem stores only a bare line_item_id string, not a real relation, and
there is no module link between ReservationItem and the Order module, so the
Admin API and dashboard can never show which order a reservation is for. This
lists reservations and orders, builds a line item to order lookup that stands in
for the Order module's own OrderItem join, and reports every reservation as
traced, orphaned, or not order backed. The only write is optional enrichment:
stamping the resolved order id into a traced reservation's own metadata.
Run on a schedule, or on demand. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/reservation-missing-order-id/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("trace_reservation_orders")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
REPORT_PATH = os.environ.get("REPORT_PATH", "reservation_trace_report.csv")
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


def admin_post(token, path, body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def trace_reservations_to_orders(reservations, orders):
    """Pure decision function. No I/O.

    reservations: [{"id": str, "line_item_id": str | None, "inventory_item_id": str, "quantity": int}]
    orders: [{"id": str, "items": [{"id": str}]}]

    Returns [{"reservation_id": str, "order_id": str | None,
              "status": "traced" | "orphaned_line_item" | "no_line_item"}]

    Build a lookup: order line-item id -> order id, by walking each order's items[]
    (this stands in for the real OrderItem join: Order 1--* OrderItem *--1 OrderLineItem).
    """
    line_item_to_order = {}
    for order in orders:
        for item in order.get("items") or []:
            line_item_to_order[item["id"]] = order["id"]

    results = []
    for r in reservations:
        line_item_id = r.get("line_item_id")
        if not line_item_id:
            results.append({"reservation_id": r["id"], "order_id": None, "status": "no_line_item"})
            continue
        order_id = line_item_to_order.get(line_item_id)
        if not order_id:
            results.append({"reservation_id": r["id"], "order_id": None, "status": "orphaned_line_item"})
            continue
        results.append({"reservation_id": r["id"], "order_id": order_id, "status": "traced"})
    return results


def list_reservations(token):
    reservations = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/reservations", {
            "fields": "id,inventory_item_id,location_id,quantity,line_item_id,created_at",
            "limit": limit,
            "offset": offset,
        })
        reservations.extend(data["reservations"])
        offset += limit
        if offset >= data["count"]:
            return reservations


def list_orders(token):
    orders = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,*items",
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def stamp_resolved_order_id(token, reservation_id, order_id):
    return admin_post(token, f"/admin/reservations/{reservation_id}", {
        "metadata": {"resolved_order_id": order_id},
    })


def write_report(path, rows):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["reservation_id", "inventory_item_id", "order_id", "status"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def run():
    token = get_admin_token()
    reservations = list_reservations(token)
    orders = list_orders(token)
    trace = trace_reservations_to_orders(reservations, orders)

    by_id = {r["id"]: r for r in reservations}
    report_rows = []
    enriched = 0
    orphaned = 0
    no_line_item = 0

    for result in trace:
        reservation = by_id[result["reservation_id"]]
        report_rows.append({
            "reservation_id": result["reservation_id"],
            "inventory_item_id": reservation["inventory_item_id"],
            "order_id": result["order_id"] or "",
            "status": result["status"],
        })

        if result["status"] == "traced":
            log.info(
                "Reservation %s traced to order %s. %s",
                result["reservation_id"], result["order_id"],
                "would stamp metadata" if DRY_RUN else "stamping metadata",
            )
            if not DRY_RUN:
                stamp_resolved_order_id(token, result["reservation_id"], result["order_id"])
            enriched += 1
        elif result["status"] == "orphaned_line_item":
            log.warning(
                "Reservation %s has an orphaned line_item_id, flagged for manual review.",
                result["reservation_id"],
            )
            orphaned += 1
        else:
            no_line_item += 1

    write_report(REPORT_PATH, report_rows)
    log.info(
        "Done. %d traced (%s), %d orphaned, %d not order backed. Report written to %s.",
        enriched, "enriched" if not DRY_RUN else "would enrich", orphaned, no_line_item, REPORT_PATH,
    )


if __name__ == "__main__":
    run()
