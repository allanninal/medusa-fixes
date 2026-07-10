"""Find Medusa v2 orders where a payment was captured but the order never
advanced off not_paid, and repair them the safe way. Never writes payment_status
directly, since it is derived, not stored. DRY_RUN=true only logs the
order_id/payment_id pairs it would re-trigger. Safe to run again and again,
because re-invoking capture on an already captured payment cannot double charge.

Guide: https://www.allanninal.dev/medusa/payment-captured-but-order-not-paid/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_payment_status")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

UNPAID_STATUSES = {"not_paid", "awaiting"}
STALE_COLLECTION_STATUSES = {"not_paid", "awaiting", "authorized"}

ORDER_FIELDS = (
    "id,status,payment_status,*summary,"
    "*payment_collections,*payment_collections.payments,"
    "payment_collections.payments.captured_at,"
    "payment_collections.payments.captures,"
    "payment_collections.payments.captures.raw_amount"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_recent_orders(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/orders",
            params={"fields": ORDER_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["orders"])
        offset += limit
        if offset >= body["count"]:
            return out


def detect_payment_status_mismatch(order):
    """Pure: no I/O. order is a dict with payment_status, summary, payment_collections.

    Returns {"orderId": str, "mismatched": bool, "reason": str | None}.
    """
    total_captured = 0
    stale_collection = False
    for pc in order.get("payment_collections", []) or []:
        pc_captured = 0
        for payment in pc.get("payments", []) or []:
            for capture in payment.get("captures", []) or []:
                pc_captured += capture.get("raw_amount", {}).get("value", 0)
        total_captured += pc_captured
        if pc_captured > 0 and pc.get("status") in STALE_COLLECTION_STATUSES:
            stale_collection = True

    paid_total = (order.get("summary") or {}).get("raw_paid_total", {}).get("value", 0)
    payment_status = order.get("payment_status")

    reason = None
    if total_captured > 0 and payment_status in UNPAID_STATUSES:
        reason = "captured funds exist but payment_status is still %s" % payment_status
    elif total_captured > 0 and paid_total == 0:
        reason = "captured funds exist but summary.raw_paid_total is 0"
    elif stale_collection:
        reason = "a payment_collection is captured but its own status has not advanced"

    return {
        "orderId": order.get("id"),
        "mismatched": reason is not None,
        "reason": reason,
    }


def flagged_payment_ids(order):
    """Collect the payment_id values worth re-invoking capture on for this order."""
    ids = []
    for pc in order.get("payment_collections", []) or []:
        for payment in pc.get("payments", []) or []:
            if payment.get("captured_at") and payment.get("id"):
                ids.append(payment["id"])
    return ids


def reinvoke_capture(token, payment_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/payments/{payment_id}/capture",
        json={},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_order(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders/{order_id}",
        params={"fields": ORDER_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["order"]


def run():
    token = get_token()
    orders = list_recent_orders(token)

    flagged = []
    for order in orders:
        result = detect_payment_status_mismatch(order)
        if result["mismatched"]:
            flagged.append((order, result))

    if not flagged:
        log.info("No payment_status mismatches found across %d order(s).", len(orders))
        return

    for order, result in flagged:
        payment_ids = flagged_payment_ids(order)
        if not payment_ids:
            log.warning(
                "Order %s mismatched (%s) but has no local Payment with captured_at set. "
                "Flagging to a human, not writing status.", order["id"], result["reason"],
            )
            continue

        for payment_id in payment_ids:
            log.info(
                "Order %s payment %s: %s. %s",
                order["id"], payment_id, result["reason"],
                "Would re-invoke capture" if DRY_RUN else "Re-invoking capture",
            )
            if not DRY_RUN:
                reinvoke_capture(token, payment_id)

        if not DRY_RUN:
            refreshed = get_order(token, order["id"])
            still_mismatched = detect_payment_status_mismatch(refreshed)["mismatched"]
            if still_mismatched:
                log.warning(
                    "Order %s still mismatched after re-invoking capture. "
                    "Flagging to a human, not writing status.", order["id"],
                )
            else:
                log.info("Order %s confirmed reconciled. payment_status=%s",
                         order["id"], refreshed["payment_status"])

    log.info("Done. %d order(s) %s.", len(flagged), "to reconcile" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
