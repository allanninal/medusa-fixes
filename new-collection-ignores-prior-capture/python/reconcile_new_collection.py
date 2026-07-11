"""Flag, and optionally repair, Medusa v2 orders where an order-edit-triggered
payment collection was sized off the order's current total instead of
order.summary.pending_difference. createOrderPaymentCollectionWorkflow does not
net out prior captures recorded in payment_collections and transactions, so a
partially paid order that gets a price bump ends up with a new collection
demanding the full new total instead of just what remains outstanding
(see medusajs/medusa#11591, #10686, #13068). This script is report-only by
default. Under an explicit DRY_RUN=false, it repairs only unambiguous cases:
exactly one open collection, a prior capture, and something genuinely owed.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/new-collection-ignores-prior-capture/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_new_collection")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

OPEN_STATUSES = {"not_paid", "awaiting"}
DEFAULT_EPSILON = 0.01

ORDER_FIELDS = (
    "id,display_id,status,*summary,*payment_collections,"
    "*payment_collections.payments,*transactions"
)


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


def reconcile_outstanding_amount(summary, open_collections, epsilon=DEFAULT_EPSILON):
    """Pure decision function. No I/O.

    summary: {currentOrderTotal, paidTotal, refundedTotal, transactionTotal}
    open_collections: [{id, amount, status}]

    Returns {"action": "none" | "flag" | "recreate", "correctAmount", "staleCollectionIds"}.
    """
    pending_difference = (
        summary["currentOrderTotal"] - summary["paidTotal"] - summary["refundedTotal"]
    )

    candidates = [c for c in open_collections if c["status"] in OPEN_STATUSES]
    open_total = sum(c["amount"] for c in candidates)

    if pending_difference <= epsilon:
        return {"action": "none", "correctAmount": max(pending_difference, 0), "staleCollectionIds": []}

    over_sized = (open_total - pending_difference) > epsilon
    prior_capture = summary["paidTotal"] > 0

    if not (over_sized and prior_capture):
        return {"action": "none", "correctAmount": max(pending_difference, 0), "staleCollectionIds": []}

    if len(candidates) == 1:
        return {
            "action": "recreate",
            "correctAmount": max(pending_difference, 0),
            "staleCollectionIds": [candidates[0]["id"]],
        }

    return {
        "action": "flag",
        "correctAmount": max(pending_difference, 0),
        "staleCollectionIds": [c["id"] for c in candidates],
    }


def to_decision_input(raw_order):
    summary = raw_order.get("summary") or {}
    collections = raw_order.get("payment_collections") or []

    decision_summary = {
        "currentOrderTotal": summary.get("current_order_total", 0),
        "paidTotal": summary.get("paid_total", 0),
        "refundedTotal": summary.get("refunded_total", 0),
        "transactionTotal": summary.get("transaction_total", 0),
    }
    open_collections = [
        {"id": c.get("id"), "amount": c.get("amount", 0), "status": c.get("status")}
        for c in collections
    ]

    return {
        "id": raw_order.get("id"),
        "displayId": raw_order.get("display_id"),
        "currencyCode": raw_order.get("currency_code"),
        "summary": decision_summary,
        "openCollections": open_collections,
    }


def list_orders_with_collections(token):
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


def refetch_pending_difference(token, order_id):
    data = admin_get(token, f"/admin/orders/{order_id}", {"fields": "id,*summary"})
    return data["order"]["summary"].get("pending_difference", 0)


def cancel_collection(token, collection_id):
    r = requests.post(
        f"{BACKEND_URL}/admin/payment-collections/{collection_id}/mark-as-canceled",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def create_collection(token, order_id, amount, currency_code):
    r = requests.post(
        f"{BACKEND_URL}/admin/payment-collections",
        headers={"Authorization": f"Bearer {token}"},
        json={"order_id": order_id, "amount": amount, "currency_code": currency_code},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_admin_token()
    raw_orders = list_orders_with_collections(token)

    flagged = 0
    repaired = 0
    for raw_order in raw_orders:
        decision_input = to_decision_input(raw_order)
        outcome = reconcile_outstanding_amount(
            decision_input["summary"], decision_input["openCollections"]
        )
        if outcome["action"] == "none":
            continue

        old_amount = sum(
            c["amount"] for c in decision_input["openCollections"] if c["status"] in OPEN_STATUSES
        )
        log.warning(
            "Order %s action=%s old_amount=%s reconciled_amount=%s prior_captured_total=%s "
            "stale_collection_ids=%s",
            decision_input["displayId"] or decision_input["id"],
            outcome["action"], old_amount, outcome["correctAmount"],
            decision_input["summary"]["paidTotal"], outcome["staleCollectionIds"],
        )
        flagged += 1

        if outcome["action"] == "recreate" and not DRY_RUN:
            fresh_amount = refetch_pending_difference(token, decision_input["id"])
            cancel_collection(token, outcome["staleCollectionIds"][0])
            create_collection(
                token, decision_input["id"], fresh_amount, decision_input["currencyCode"]
            )
            repaired += 1

    log.info(
        "Done. %d order(s) flagged, %d repaired. %s",
        flagged, repaired,
        "Dry run, no writes made." if DRY_RUN else "Repairs applied where unambiguous.",
    )


if __name__ == "__main__":
    run()
