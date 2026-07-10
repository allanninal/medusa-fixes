"""Reconcile Medusa refunds that never reached the order's summary.

In Medusa v2, orders and payments are separate modules joined only through
module links. order.summary (paid_total, refunded_total, accounting_total) is
a cached snapshot that only recomputes when a refund runs through
refundPaymentsWorkflow. A refund recorded directly on the Payment module, by a
custom payment provider or a webhook outside the workflow, leaves the ledger
correct but the order stale. This lists orders with payments and refunds
expanded, flags any order where the ledger is ahead of the order, and resyncs
only that direction by calling the same refund route the admin Refund action
uses, with the exact amount already confirmed on the Payment module side.
Orders where the order shows more refunded than the ledger are flagged for
manual review, never auto-repaired.

Guide: https://www.allanninal.dev/medusa/refund-not-reflected-on-the-order/

Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_refunds")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01

ORDER_FIELDS = (
    "id,display_id,status,summary,*payment_collections,"
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


def admin_post(token, path, json_body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=json_body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_refund_reconciliation(order):
    """Pure decision function. No I/O.

    order: {
      "id": str,
      "summary": {"paid_total": float, "refunded_total": float,
                   "transaction_total": float, "accounting_total": float},
      "payment_collections": [
        {"status": str, "payments": [
          {"amount": float, "captured_at": str | None,
           "refunds": [{"amount": float, "created_at": str}]}
        ]}
      ],
    }

    Returns {"orderId", "needsSync", "ledgerRefundedTotal", "orderRefundedTotal",
             "delta", "reason"} where reason is one of
             "refund_not_reflected" | "over_refunded_on_order" | "in_sync".
    """
    payments = [
        payment
        for collection in (order.get("payment_collections") or [])
        for payment in (collection.get("payments") or [])
    ]
    ledger_refunded_total = sum(
        refund.get("amount", 0)
        for payment in payments
        for refund in (payment.get("refunds") or [])
    )
    order_refunded_total = (order.get("summary") or {}).get("refunded_total", 0)
    delta = ledger_refunded_total - order_refunded_total

    if delta > EPSILON:
        reason = "refund_not_reflected"
        needs_sync = True
    elif delta < -EPSILON:
        reason = "over_refunded_on_order"
        needs_sync = True
    else:
        reason = "in_sync"
        needs_sync = False

    return {
        "orderId": order.get("id"),
        "needsSync": needs_sync,
        "ledgerRefundedTotal": ledger_refunded_total,
        "orderRefundedTotal": order_refunded_total,
        "delta": delta,
        "reason": reason,
    }


def list_orders_with_payments(token):
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


def first_payment_id(order):
    for collection in order.get("payment_collections") or []:
        for payment in collection.get("payments") or []:
            if payment.get("id"):
                return payment["id"]
    return None


def resync_refund(token, payment_id, delta):
    return admin_post(token, f"/admin/payments/{payment_id}/refund", {"amount": delta})


def get_order_refunded_total(token, order_id):
    data = admin_get(token, f"/admin/orders/{order_id}", {
        "fields": "summary,*payment_collections.payments.refunds",
    })
    return data["order"]["summary"]["refunded_total"]


def run():
    token = get_admin_token()
    orders = list_orders_with_payments(token)

    synced = 0
    flagged = 0
    for order in orders:
        outcome = decide_refund_reconciliation(order)
        if not outcome["needsSync"]:
            continue

        if outcome["reason"] == "over_refunded_on_order":
            log.warning(
                "Order %s over-refunded on the order side (ledger=%s order=%s). Flagging for manual review.",
                order.get("display_id") or order["id"], outcome["ledgerRefundedTotal"], outcome["orderRefundedTotal"],
            )
            flagged += 1
            continue

        payment_id = first_payment_id(order)
        if payment_id is None:
            log.warning("Order %s has a refund gap but no payment id found. Flagging.", order["id"])
            flagged += 1
            continue

        log.warning(
            "Order %s refund not reflected: ledger=%s order=%s delta=%s. %s",
            order.get("display_id") or order["id"], outcome["ledgerRefundedTotal"],
            outcome["orderRefundedTotal"], outcome["delta"],
            "would resync" if DRY_RUN else "resyncing",
        )

        if not DRY_RUN:
            resync_refund(token, payment_id, outcome["delta"])
            confirmed_total = get_order_refunded_total(token, order["id"])
            if abs(confirmed_total - outcome["ledgerRefundedTotal"]) > EPSILON:
                log.warning(
                    "  order %s did not resync as expected: ledger=%s order_now=%s",
                    order["id"], outcome["ledgerRefundedTotal"], confirmed_total,
                )
            else:
                log.info("  order %s confirmed in sync: refunded_total=%s", order["id"], confirmed_total)

        synced += 1

    log.info(
        "Done. %d order(s) %s, %d order(s) flagged for manual review.",
        synced, "to resync" if DRY_RUN else "resynced", flagged,
    )


if __name__ == "__main__":
    run()
