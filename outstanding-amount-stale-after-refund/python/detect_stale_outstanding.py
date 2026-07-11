"""Flag Medusa v2 orders whose outstanding_amount stopped updating after the
first refund. outstanding_amount is a derived field on the order's summary,
computed by the totals module from order_transaction rows, not a value that
gets decremented directly. The first refund on an order inserts a new
transaction row and the summary recomputes correctly, but a second
refundPaymentsWorkflow run on the same order or payment does not insert
another row (see medusajs/medusa#11481), so the summary is never recomputed
again and outstanding_amount freezes while the payment provider keeps
processing more refunds. There is no safe PATCH for this field, so this
script only flags the divergence for a human to reconcile. It never calls
the refund endpoint again. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/outstanding-amount-stale-after-refund/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_stale_outstanding")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01

ORDER_FIELDS = (
    "id,display_id,*summary,*payment_collections,"
    "*payment_collections.payments,*payment_collections.payments.refunds"
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


def detect_stale_outstanding(order):
    """Pure decision function. No I/O.

    order: {
      "total": float,
      "captures": [{"amount": float}],
      "refunds": [{"id": str, "amount": float, "created_at": str}],
      "reportedOutstanding": float,
    }

    Returns {"affected", "trueOutstanding", "reportedOutstanding", "delta",
             "refundCount"}.
    """
    captures = order.get("captures") or []
    refunds = order.get("refunds") or []

    true_outstanding = (
        order["total"]
        - sum(c["amount"] for c in captures)
        + sum(r["amount"] for r in refunds)
    )
    refund_count = len(refunds)
    delta = order["reportedOutstanding"] - true_outstanding
    affected = refund_count > 1 and abs(delta) > EPSILON

    return {
        "affected": affected,
        "trueOutstanding": true_outstanding,
        "reportedOutstanding": order["reportedOutstanding"],
        "delta": delta,
        "refundCount": refund_count,
    }


def to_decision_input(raw_order):
    payments = [
        payment
        for collection in (raw_order.get("payment_collections") or [])
        for payment in (collection.get("payments") or [])
    ]
    captures = [{"amount": p.get("amount", 0)} for p in payments if p.get("captured_at")]
    refunds = [
        {"id": r.get("id"), "amount": r.get("amount", 0), "created_at": r.get("created_at")}
        for p in payments
        for r in (p.get("refunds") or [])
    ]
    summary = raw_order.get("summary") or {}

    return {
        "id": raw_order.get("id"),
        "displayId": raw_order.get("display_id"),
        "total": summary.get("raw_current_order_total", raw_order.get("total", 0)),
        "captures": captures,
        "refunds": refunds,
        "reportedOutstanding": summary.get("outstanding_amount", 0),
    }


def list_orders_with_refunds(token):
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


def run():
    token = get_admin_token()
    raw_orders = list_orders_with_refunds(token)

    flagged = 0
    for raw_order in raw_orders:
        decision_input = to_decision_input(raw_order)
        outcome = detect_stale_outstanding(decision_input)
        if not outcome["affected"]:
            continue

        flagged += 1
        log.warning(
            "Order %s stale outstanding_amount: reported=%s true=%s delta=%s "
            "refund_count=%d refunds=%s. %s",
            decision_input["displayId"] or decision_input["id"],
            outcome["reportedOutstanding"], outcome["trueOutstanding"], outcome["delta"],
            outcome["refundCount"],
            [(r["id"], r["amount"], r["created_at"]) for r in decision_input["refunds"]],
            "would flag for review" if DRY_RUN else "flagging for review",
        )

    log.info(
        "Done. %d order(s) with a stale outstanding_amount flagged for manual reconciliation. "
        "No orders were written to.",
        flagged,
    )


if __name__ == "__main__":
    run()
