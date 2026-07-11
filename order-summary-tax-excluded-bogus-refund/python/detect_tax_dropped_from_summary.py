"""Flag Medusa v2 orders whose summary reports a phantom overpayment because
tax_total was left out of the summary's own totals math. order.total is
computed correctly as subtotal + shipping_total + tax_total minus discounts,
but summary.accounting_total and the pending_difference built on top of it
are computed from subtotal + shipping_total alone (see medusajs/medusa#13405).
A fully paid, tax-inclusive order therefore looks overpaid by exactly the
tax amount, and anything wired to pending_difference can issue a bogus
refund for money nobody actually overpaid. This script only flags the
divergence, and if a refund already matched the missing tax it flags that
too, gated behind DRY_RUN. It never issues a refund or a recharge. Safe to
run again and again.

Guide: https://www.allanninal.dev/medusa/order-summary-tax-excluded-bogus-refund/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_tax_dropped_from_summary")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01

ORDER_FIELDS = (
    "id,display_id,total,tax_total,subtotal,shipping_total,"
    "summary.accounting_total,summary.current_order_total,summary.pending_difference,"
    "summary.paid_total,summary.transaction_total,summary.refunded_total"
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


def detect_tax_dropped_from_summary(order, epsilon=EPSILON):
    """Pure decision function. No I/O.

    order: {
      "total": float, "tax_total": float,
      "summary": {"accounting_total": float, "current_order_total": float,
                  "pending_difference": float, "paid_total": float},
    }

    Returns {"affected", "drift", "correctedPendingDifference"}.
    """
    summary = order["summary"]
    drift = order["total"] - summary["accounting_total"]
    tax_total = order["tax_total"]

    affected = tax_total > 0 and abs(drift - tax_total) <= epsilon
    corrected_pending_difference = order["total"] - summary["paid_total"]

    return {
        "affected": affected,
        "drift": drift,
        "correctedPendingDifference": corrected_pending_difference,
    }


def already_refunded_tax(order_id, tax_total, token, epsilon=EPSILON):
    data = admin_get(
        token,
        f"/admin/orders/{order_id}/payment-collections",
        {"fields": "id,status,*payments,*payments.refunds"},
    )
    for collection in data.get("payment_collections", []):
        for payment in collection.get("payments") or []:
            for refund in payment.get("refunds") or []:
                if abs(refund.get("amount", 0) - tax_total) <= epsilon:
                    return True
    return False


def flag_order(order_id, tax_total, token):
    admin_post(token, f"/admin/orders/{order_id}", {
        "metadata": {"flagged_tax_refund_drift": True, "expected_manual_recharge": tax_total},
    })


def list_orders_with_summary(token):
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
    raw_orders = list_orders_with_summary(token)

    report = {}
    flagged = 0
    for raw_order in raw_orders:
        outcome = detect_tax_dropped_from_summary(raw_order)
        if not outcome["affected"]:
            continue

        order_id = raw_order["id"]
        report[order_id] = {
            "correct_total": raw_order["total"],
            "buggy_accounting_total": raw_order["summary"]["accounting_total"],
            "drift": raw_order["tax_total"],
        }

        already_refunded = already_refunded_tax(order_id, raw_order["tax_total"], token)
        flagged += 1
        log.warning(
            "Order %s tax dropped from summary: correct_total=%s buggy_accounting_total=%s "
            "drift=%s corrected_pending_difference=%s already_refunded=%s. %s",
            raw_order.get("display_id") or order_id,
            raw_order["total"], raw_order["summary"]["accounting_total"],
            outcome["drift"], outcome["correctedPendingDifference"], already_refunded,
            "would flag for review" if DRY_RUN else "flagging for review",
        )
        if already_refunded and not DRY_RUN:
            flag_order(order_id, raw_order["tax_total"], token)

    log.info(
        "Done. %d order(s) with tax dropped from the summary flagged for manual review. "
        "No refund or recharge was issued by this script.",
        flagged,
    )
    return report


if __name__ == "__main__":
    run()
