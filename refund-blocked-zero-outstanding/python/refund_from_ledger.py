"""Refund Medusa payments that are wrongly blocked by a zero-outstanding order summary.

In Medusa v2, the Admin dashboard's Refund action and most custom refund code
check the order's derived summary fields, paid_total, refunded_total, and
outstanding_amount, instead of the actual captured amount on the Payment
module record. When that summary is computed or cached incorrectly after a
capture, for example with a custom payment provider, multiple payment
collections, or rounding in totals recalculation, it can read
outstanding_amount as zero while the payment is still fully refundable, and
the guard throws "Order does not have an outstanding balance to refund" on a
perfectly legitimate refund. This lists captured, non-refunded orders with
their payments expanded, computes the true refundable amount as
payment.amount minus payment.amount_refunded straight from the Payment
module, re-confirms it right before writing, and calls the refund route
directly, bypassing the unreliable order-summary gate.
Run on demand or on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/refund-blocked-zero-outstanding/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refund_from_ledger")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_FIELDS = (
    "id,display_id,status,summary.paid_total,summary.refunded_total,"
    "summary.transaction_total,*payment_collections,*payment_collections.payments"
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


def to_decimal(value):
    return float(value or 0)


def payments_of(order):
    return [
        payment
        for collection in (order.get("payment_collections") or [])
        for payment in (collection.get("payments") or [])
    ]


def decide_refund(payment, order_summary, requested_amount):
    """Pure decision function. No I/O.

    payment: {"amount": float, "amount_refunded": float, "captured_at": str | None}
    order_summary: {"transaction_total": float, "paid_total": float, "refunded_total": float}
    requested_amount: float

    Returns {"allow": bool, "refundable_amount": str, "reason": str | None}.
    """
    if payment.get("captured_at") is None:
        return {"allow": False, "refundable_amount": "0", "reason": "not_captured"}

    payment_refundable = to_decimal(payment.get("amount")) - to_decimal(payment.get("amount_refunded"))
    summary_refundable = to_decimal(order_summary.get("paid_total")) - to_decimal(order_summary.get("refunded_total"))

    # The payment ledger is the source of truth. The order summary is a
    # diagnostic signal only, never the blocking condition.
    true_refundable = payment_refundable

    if to_decimal(requested_amount) > true_refundable:
        return {"allow": False, "refundable_amount": str(true_refundable), "reason": "exceeds_refundable"}

    if summary_refundable <= 0 and payment_refundable > 0:
        return {
            "allow": True,
            "refundable_amount": str(true_refundable),
            "reason": "summary_outstanding_zero_but_payment_captured",
        }

    return {"allow": True, "refundable_amount": str(true_refundable), "reason": None}


def list_captured_orders(token):
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


def refetch_payment(token, payment_id):
    data = admin_get(token, f"/admin/payments/{payment_id}", {
        "fields": "id,amount,amount_refunded,captured_at,*payment_collection",
    })
    return data["payment"]


def refund_payment(token, payment_id, amount):
    payment = refetch_payment(token, payment_id)
    if payment.get("captured_at") is None:
        raise RuntimeError(f"payment {payment_id} is not captured, refusing to refund")
    if to_decimal(payment.get("amount_refunded")) + to_decimal(amount) > to_decimal(payment.get("amount")):
        raise RuntimeError(f"payment {payment_id} refund would exceed captured amount")
    return admin_post(token, f"/admin/payments/{payment_id}/refund", {"amount": amount})


def get_order_refunded_total(token, order_id):
    data = admin_get(token, f"/admin/orders/{order_id}", {
        "fields": "summary.refunded_total,*payment_collections.payments",
    })
    return data["order"]["summary"]["refunded_total"]


def run():
    token = get_admin_token()
    orders = list_captured_orders(token)

    refunded = 0
    skipped = 0
    for order in orders:
        summary = order.get("summary") or {}
        for payment in payments_of(order):
            payment_refundable = to_decimal(payment.get("amount")) - to_decimal(payment.get("amount_refunded"))
            if payment_refundable <= 0:
                continue

            outcome = decide_refund(payment, summary, payment_refundable)
            label = order.get("display_id") or order["id"]

            if not outcome["allow"]:
                log.info("Order %s payment %s not refunded: %s", label, payment.get("id"), outcome["reason"])
                skipped += 1
                continue

            if outcome["reason"] == "summary_outstanding_zero_but_payment_captured":
                log.warning(
                    "Order %s payment %s: summary reads zero outstanding but payment is captured and refundable=%s. %s",
                    label, payment.get("id"), outcome["refundable_amount"],
                    "would refund" if DRY_RUN else "refunding",
                )
            else:
                log.info(
                    "Order %s payment %s refundable=%s. %s",
                    label, payment.get("id"), outcome["refundable_amount"],
                    "would refund" if DRY_RUN else "refunding",
                )

            if not DRY_RUN:
                before = summary.get("refunded_total")
                refund_payment(token, payment["id"], outcome["refundable_amount"])
                after = get_order_refunded_total(token, order["id"])
                log.info("  order %s summary.refunded_total before=%s after=%s", order["id"], before, after)

            refunded += 1

    log.info(
        "Done. %d payment(s) %s, %d skipped.",
        refunded, "to refund" if DRY_RUN else "refunded", skipped,
    )


if __name__ == "__main__":
    run()
