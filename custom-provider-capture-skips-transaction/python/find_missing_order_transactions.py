"""Find Medusa v2 orders where a custom payment provider returned "captured"
straight from authorizePayment, skipping the order transaction that the
normal capturePaymentWorkflow would have written with addOrderTransactionStep.

Because order.summary.paid_total is computed purely from OrderTransaction
rows, not from Payment.amount or Payment.captured_at, these orders look
outstanding even though the provider and the Payment record both agree the
money was captured. This lists orders and payments, flags the mismatch, and
in DRY_RUN=false mode reports the exact medusa exec command to run to write
the missing transaction. Multiple payments, partial captures, or prior
refunds on an order are always flagged for manual review, never auto-repaired.

Guide: https://www.allanninal.dev/medusa/custom-provider-capture-skips-transaction/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_order_transactions")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDERS_FIELDS = (
    "id,display_id,currency_code,summary.paid_total,"
    "summary.transaction_total,summary.current_order_total,"
    "*payment_collections.payments"
)


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_orders(token, offset=0, limit=50):
    r = requests.get(
        f"{BACKEND_URL}/admin/orders",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": ORDERS_FIELDS, "offset": offset, "limit": limit},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_order_transactions(token, order_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/orders/{order_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*transactions"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["order"].get("transactions") or []


def existing_payment_refs(transactions):
    return {
        t["reference_id"]
        for t in transactions
        if t.get("reference") == "payment" and t.get("reference_id")
    }


def flatten_payments(order):
    payments = []
    for collection in order.get("payment_collections") or []:
        for payment in collection.get("payments") or []:
            payments.append(payment)
    return payments


def decide_order_transaction_repair(order, payments, existing_transaction_refs):
    """Pure decision function. No I/O.

    order: {"id": str, "currency_code": str, "paid_total": float}
    payments: [{"id": str, "amount": float, "captured_at": str | None, "canceled_at": str | None}, ...]
    existing_transaction_refs: set of payment ids already covered by an OrderTransaction

    Returns {"action": "create_transaction" | "flag_ambiguous" | "noop",
             "order_id": str, "missing_amount": float, "payment_id": str | None}

    Logic:
      1. captured_payments = payments with captured_at set and canceled_at unset.
         If there are none, return "noop".
      2. expected_captured = sum of captured payment amounts.
      3. If there is more than one captured payment, or the existing reference
         set partially covers some but not all captured payments, return
         "flag_ambiguous" since it is unsafe to auto-repair.
      4. If there is exactly one captured payment, it is missing from
         existing_transaction_refs, and paid_total is less than
         expected_captured, return "create_transaction" with the missing
         amount and payment id.
      5. Otherwise return "noop".
    """
    captured = [p for p in payments if p.get("captured_at") and not p.get("canceled_at")]
    if not captured:
        return {"action": "noop", "order_id": order["id"], "missing_amount": 0, "payment_id": None}

    expected_captured = sum(p["amount"] for p in captured)
    covered = sum(1 for p in captured if p["id"] in existing_transaction_refs)

    if len(captured) > 1 or (0 < covered < len(captured)):
        return {"action": "flag_ambiguous", "order_id": order["id"], "missing_amount": 0, "payment_id": None}

    payment = captured[0]
    if payment["id"] not in existing_transaction_refs and order["paid_total"] < expected_captured:
        return {
            "action": "create_transaction",
            "order_id": order["id"],
            "missing_amount": expected_captured - order["paid_total"],
            "payment_id": payment["id"],
        }

    return {"action": "noop", "order_id": order["id"], "missing_amount": 0, "payment_id": None}


def iter_orders(token):
    offset = 0
    limit = 50
    while True:
        data = list_orders(token, offset=offset, limit=limit)
        for order in data.get("orders", []):
            yield order
        offset += limit
        if offset >= data.get("count", 0):
            return


def run():
    token = get_admin_token()
    to_create = 0
    to_flag = 0
    for order in iter_orders(token):
        payments = flatten_payments(order)
        if not payments:
            continue
        transactions = get_order_transactions(token, order["id"])
        refs = existing_payment_refs(transactions)
        decision = decide_order_transaction_repair(
            {
                "id": order["id"],
                "currency_code": order["currency_code"],
                "paid_total": (order.get("summary") or {}).get("paid_total", 0),
            },
            payments,
            refs,
        )

        if decision["action"] == "flag_ambiguous":
            log.warning("Order %s has an ambiguous capture history. Flagging for manual review.", order["id"])
            to_flag += 1
            continue

        if decision["action"] != "create_transaction":
            continue

        record = {
            "order_id": decision["order_id"],
            "payment_id": decision["payment_id"],
            "amount": decision["missing_amount"],
            "currency_code": order["currency_code"],
        }

        if DRY_RUN:
            log.info(
                "Would create transaction. order_id=%s payment_id=%s amount=%s currency_code=%s",
                record["order_id"], record["payment_id"], record["amount"], record["currency_code"],
            )
        else:
            log.info(
                "Run inside the Medusa project: npx medusa exec ./src/scripts/create-order-transaction.ts "
                "%s %s %s %s",
                record["order_id"], record["amount"], record["currency_code"], record["payment_id"],
            )
        to_create += 1

    log.info(
        "Done. %d order(s) %s a missing transaction, %d order(s) flagged for manual review.",
        to_create, "need" if DRY_RUN else "were repaired for", to_flag,
    )


if __name__ == "__main__":
    run()
