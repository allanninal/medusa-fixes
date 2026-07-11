"""Find Medusa orders where a second refund silently failed.

Medusa v2's refund-payment workflow historically validates a refund request
against the order's cached summary.pending_difference instead of re-summing
that specific payment's actual captures minus its existing refunds. The first
refund on an order correctly zeroes or flips the sign of the order-level
balance, so validate-refund-step rejects every refund attempt after that with
"Order does not have an outstanding balance to refund", even though the
payment itself may still have capturable or refundable amount left. This
lists orders with captures and refunds expanded, computes the true shortfall
per payment independent of the order summary, and flags every payment that is
silently blocked. It never fires a refund unless DRY_RUN is false and a human
has approved the list, since this is real money moving through a provider.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/second-refund-fails/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("refund_shortfall")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01

ORDER_FIELDS = (
    "id,display_id,summary,*payment_collections,"
    "*payment_collections.payments,*payment_collections.payments.captures,"
    "*payment_collections.payments.refunds"
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


def compute_refund_shortfall(payment, order_pending_difference):
    """Pure decision function. No I/O.

    payment: {"id": str, "captures": [{"raw_amount": float}], "refunds": [{"raw_amount": float}]}
    order_pending_difference: float, the order's own cached summary.pending_difference

    Returns {"paymentId", "capturedTotal", "refundedTotal", "shortfall", "isSilentlyBlocked"}.
    """
    captured_total = sum(c.get("raw_amount", 0) for c in (payment.get("captures") or []))
    refunded_total = sum(r.get("raw_amount", 0) for r in (payment.get("refunds") or []))
    shortfall = captured_total - refunded_total
    is_silently_blocked = shortfall > EPSILON and order_pending_difference <= EPSILON

    return {
        "paymentId": payment.get("id"),
        "capturedTotal": captured_total,
        "refundedTotal": refunded_total,
        "shortfall": shortfall,
        "isSilentlyBlocked": is_silently_blocked,
    }


def list_orders_with_ledger(token):
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


def payments_of(order):
    return [
        payment
        for collection in (order.get("payment_collections") or [])
        for payment in (collection.get("payments") or [])
    ]


def fire_makeup_refund(token, payment_id, shortfall):
    return admin_post(token, f"/admin/payments/{payment_id}/refund", {"amount": shortfall})


def run():
    token = get_admin_token()
    orders = list_orders_with_ledger(token)

    flagged = 0
    for order in orders:
        pending_difference = (order.get("summary") or {}).get("pending_difference", 0)
        for payment in payments_of(order):
            outcome = compute_refund_shortfall(payment, pending_difference)
            if not outcome["isSilentlyBlocked"]:
                continue

            log.warning(
                "Order %s payment %s silently blocked: captured=%s refunded=%s shortfall=%s. %s",
                order.get("display_id") or order["id"], outcome["paymentId"],
                outcome["capturedTotal"], outcome["refundedTotal"], outcome["shortfall"],
                "would refund" if DRY_RUN else "refunding",
            )

            if not DRY_RUN:
                fire_makeup_refund(token, outcome["paymentId"], outcome["shortfall"])

            flagged += 1

    log.info(
        "Done. %d payment(s) %s.",
        flagged, "flagged, none refunded (dry run)" if DRY_RUN else "refunded",
    )


if __name__ == "__main__":
    run()
