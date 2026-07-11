"""Reconcile Medusa orders left partial by a continueOnPermanentFailure step.

.config({ continueOnPermanentFailure: true }) opts a step out of the saga's rollback
contract. Per Medusa's docs, the compensation function of the flagged step will not
be called, and the workflow keeps running subsequent steps as if nothing happened.
If that step already committed a side effect, an order, a captured payment, or a
reservation, and a later step then fails and triggers a rollback, the orchestrator
still does not retroactively undo the flagged step's work (PR #12027, issue #11266).

This lists recent orders with payments and fulfillments expanded, classifies each
one with a pure function, and reports every orphan as a structured record for a
human to triage. The only guarded write is deleting a dangling reservation that has
no live order line. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/continue-on-failure-skips-compensation/
"""
import os
import json
import logging
import datetime
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_skipped_compensation")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
SINCE_HOURS = float(os.environ.get("SINCE_HOURS", "24"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CAPTURED_STATUSES = {"captured", "authorized"}
STUCK_FULFILLMENT_STATUSES = {"not_fulfilled"}
DELETABLE = {"orphaned_reservation_no_order_line"}


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


def classify_orphan(order, failed_steps):
    """Pure decision function. No I/O.

    order: {"id": str, "payment_status": str, "fulfillment_status": str,
            "payments": [{"status": str}], "fulfillments": [any], "items": [any]}
    failed_steps: list of {"action": str, "handlerType": "invoke" | "compensate"}

    Returns "orphaned_payment_no_fulfillment" | "orphaned_reservation_no_order_line" | "ok".
    """
    has_continue_on_failure = any(
        s.get("handlerType") == "invoke" and "continueOnPermanentFailure" in s.get("action", "")
        for s in failed_steps
    )

    payment_committed = order.get("payment_status") in CAPTURED_STATUSES and bool(order.get("payments"))
    fulfillment_missing = (
        order.get("fulfillment_status") in STUCK_FULFILLMENT_STATUSES
        and not order.get("fulfillments")
    )
    if payment_committed and fulfillment_missing and has_continue_on_failure:
        return "orphaned_payment_no_fulfillment"

    has_dangling_reservation = any(
        s.get("action") == "reserveInventoryStep" and s.get("handlerType") == "invoke"
        for s in failed_steps
    )
    if has_dangling_reservation and not order.get("items"):
        return "orphaned_reservation_no_order_line"

    return "ok"


def list_recent_orders(token, since_iso):
    orders = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,status,fulfillment_status,payment_status,*payments,*fulfillments,*items",
            "created_at[$gte]": since_iso,
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def failed_steps_for_order(order):
    """Placeholder hook: in a real deployment, load the failed-step trail for this
    order's workflow transaction (for example from your own audit log of
    { result, errors } from someWorkflow(container).run({ input, throwOnError: false })).
    Returns [] when there is nothing on file, which classify_orphan treats as "ok".
    """
    return order.get("_failed_steps", [])


def run():
    token = get_admin_token()
    since_iso = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=SINCE_HOURS)
    ).isoformat()
    orders = list_recent_orders(token, since_iso)

    reported = 0
    cleaned = 0
    for order in orders:
        failed_steps = failed_steps_for_order(order)
        outcome = classify_orphan(order, failed_steps)
        if outcome == "ok":
            continue

        if outcome in DELETABLE:
            reservation_id = order.get("_dangling_reservation_id")
            log.warning(
                "Order %s classified as %s. reservation_id=%s. %s",
                order["id"], outcome, reservation_id, "Would delete" if DRY_RUN else "Deleting",
            )
            if not DRY_RUN and reservation_id:
                admin_delete(token, f"/admin/reservations/{reservation_id}")
            cleaned += 1
        else:
            record = {
                "order_id": order["id"],
                "action": next((s["action"] for s in failed_steps if s.get("handlerType") == "invoke"), None),
                "error_message": next((s.get("message") for s in failed_steps), None),
                "classification": outcome,
                "reported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            log.info("Orphan detected: %s", json.dumps(record))
            reported += 1

    log.info(
        "Done. %d order(s) reported for human triage, %d reservation(s) %s.",
        reported, cleaned, "to delete" if DRY_RUN else "deleted",
    )


if __name__ == "__main__":
    run()
