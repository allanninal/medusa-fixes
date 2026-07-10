"""Flag Medusa fulfillments that are shipped but carry no tracking number.

In Medusa v2, a fulfillment's tracking data lives in Fulfillment.labels[], each
label carrying tracking_number, tracking_url, and label_url, separate from the
shipped_at timestamp that actually marks it as shipped. The Admin dashboard's
Create Shipment flow, backed by createShipmentWorkflow, has historically built
the shipment's labels solely from whatever was typed into that form's tracking
number input, discarding any labels a fulfillment provider had already
attached in createFulfillment(). Because tracking entry is optional, a
merchant can click Mark as Shipped, setting shipped_at, while labels stays
empty (see medusajs/medusa issue #11160, partially addressed in PR #11775).

There is no legitimate value this script could invent for a missing tracking
number, so this only flags and reports. The only write it will ever make is
attaching a real label a human has already obtained from the carrier or
fulfillment provider, and only when DRY_RUN is off. Run on a schedule. Safe to
run again and again.

Guide: https://www.allanninal.dev/medusa/fulfillment-without-a-tracking-number/
"""
import csv
import io
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_untracked_shipments")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_FIELDS = "id,display_id,email,*fulfillments,*fulfillments.labels"


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
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_untracked_shipments(fulfillments):
    """Pure decision function. No I/O.

    fulfillments: list of {id, shipped_at, canceled_at, labels?: [{tracking_number?}]}

    A fulfillment is "shipped without tracking" iff:
      1. shipped_at is set (truthy) -> it has actually been marked shipped
      2. canceled_at is NOT set -> ignore canceled fulfillments (irrelevant once canceled)
      3. labels is missing/empty OR every label has a blank tracking_number

    Returns a list of {id, reason}.
    """
    flagged = []
    for f in fulfillments:
        is_shipped = bool(f.get("shipped_at"))
        is_canceled = bool(f.get("canceled_at"))
        labels = f.get("labels") or []
        has_tracking_number = any(
            (l.get("tracking_number") or "").strip() for l in labels
        )
        if is_shipped and not is_canceled and not has_tracking_number:
            flagged.append({
                "id": f["id"],
                "reason": "shipped_at set but no non-empty tracking_number on any label",
            })
    return flagged


def refetch_fulfillment(token, order_id, fulfillment_id):
    """Re-read a single fulfillment directly, since list responses can omit nested labels."""
    path = f"/admin/orders/{order_id}/fulfillments/{fulfillment_id}"
    data = admin_get(token, path, {"fields": "id,shipped_at,canceled_at,*labels"})
    return data["fulfillment"]


def list_orders(token):
    orders = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": ORDER_FIELDS,
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def attach_tracking_number(token, order_id, fulfillment_id, tracking_number, tracking_url=None, label_url=None):
    """The only legitimate corrective write. Never call this with a synthesized value.

    Mirrors the same route the Admin dashboard's Mark as Shipped / Create Shipment
    form calls, backed by createShipmentWorkflow.
    """
    path = f"/admin/orders/{order_id}/fulfillments/{fulfillment_id}/shipment"
    body = {"labels": [{
        "tracking_number": tracking_number,
        "tracking_url": tracking_url,
        "label_url": label_url,
    }]}
    return admin_post(token, path, body)


def write_report(rows):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=["order_id", "display_id", "fulfillment_id", "shipped_at", "provider_id"])
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


def run():
    token = get_admin_token()

    rows = []
    for order in list_orders(token):
        fulfillments = order.get("fulfillments") or []
        for flagged in find_untracked_shipments(fulfillments):
            fulfillment = next(f for f in fulfillments if f["id"] == flagged["id"])
            # Re-read directly before flagging, since list responses can omit nested labels.
            rechecked = refetch_fulfillment(token, order["id"], fulfillment["id"])
            if find_untracked_shipments([rechecked]):
                rows.append({
                    "order_id": order["id"],
                    "display_id": order.get("display_id"),
                    "fulfillment_id": fulfillment["id"],
                    "shipped_at": fulfillment.get("shipped_at"),
                    "provider_id": fulfillment.get("provider_id"),
                })
                log.warning(
                    "Order %s fulfillment %s shipped with no tracking number. %s",
                    order.get("display_id"), fulfillment["id"],
                    "would report" if DRY_RUN else "reporting",
                )

    report = write_report(rows)
    log.info("Done. %d fulfillment(s) shipped without tracking.", len(rows))
    return report


if __name__ == "__main__":
    run()
