"""Find Medusa v2 orders mislabeled partially_captured by a sub-cent BigNumber
remainder, and clear the false positive the safe way. Never writes
payment_collection.status directly, since it is computed by getLastPaymentStatus
on every read. DRY_RUN=true only logs the order_id/payment_id pairs and the
computed delta it would capture. Safe to run again and again, because it only
captures a delta strictly smaller than one currency minor unit.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("clear_rounding_mislabel")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Number of decimal digits Medusa uses for each currency's minor unit.
# Extend this map for any other zero decimal currencies your store supports.
ZERO_DECIMAL_CURRENCIES = {"jpy", "krw", "vnd"}

ORDER_FIELDS = (
    "id,display_id,status,payment_status,currency_code,"
    "*payment_collections,"
    "payment_collections.amount,"
    "payment_collections.captured_amount,"
    "payment_collections.status"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_orders(token):
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


def currency_decimal_digits(currency_code):
    return 0 if (currency_code or "").lower() in ZERO_DECIMAL_CURRENCIES else 2


def classify_capture_delta(amount, captured_amount, currency_decimal_digits):
    """Pure: no I/O. Returns delta, whether it looks like a rounding artifact,
    and the action to take: clear, flag, or none."""
    delta = round(amount - captured_amount, currency_decimal_digits + 4)
    minor_unit = 10 ** (-currency_decimal_digits)

    if delta <= 0:
        return {"delta": delta, "isRoundingArtifact": False, "action": "none"}
    if delta < minor_unit:
        return {"delta": delta, "isRoundingArtifact": True, "action": "clear"}
    return {"delta": delta, "isRoundingArtifact": False, "action": "flag"}


def payment_ids_for_collection(token, order_id, collection_id):
    """The list endpoint above does not expand nested payments, so fetch the
    order once more with payments expanded only for collections we plan to act on."""
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders/{order_id}",
        params={"fields": "id,*payment_collections.payments"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    order = r.json()["order"]
    for pc in order.get("payment_collections", []) or []:
        if pc.get("id") == collection_id:
            return [p["id"] for p in (pc.get("payments") or []) if p.get("id")]
    return []


def capture_remainder(token, payment_id, delta):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/payments/{payment_id}/capture",
        json={"amount": delta},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_order(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders/{order_id}",
        params={"fields": "id,payment_status,*payment_collections"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["order"]


def run():
    token = get_token()
    orders = list_orders(token)

    to_clear = []
    to_flag = []
    for order in orders:
        digits = currency_decimal_digits(order.get("currency_code"))
        for pc in order.get("payment_collections", []) or []:
            if pc.get("status") != "partially_captured":
                continue
            result = classify_capture_delta(pc.get("amount", 0), pc.get("captured_amount", 0), digits)
            if result["action"] == "clear":
                to_clear.append((order, pc, result))
            elif result["action"] == "flag":
                to_flag.append((order, pc, result))

    for order, pc, result in to_flag:
        log.warning(
            "Order %s collection %s: delta %s is a real outstanding balance, not rounding. Flagging for review.",
            order["id"], pc.get("id"), result["delta"],
        )

    if not to_clear:
        log.info("No rounding-artifact mislabels found across %d order(s).", len(orders))
        return

    cleared = 0
    for order, pc, result in to_clear:
        payment_ids = payment_ids_for_collection(token, order["id"], pc.get("id"))
        if not payment_ids:
            log.warning(
                "Order %s collection %s delta %s looks like a rounding artifact but has no "
                "payment to capture against. Flagging for review.", order["id"], pc.get("id"), result["delta"],
            )
            continue

        payment_id = payment_ids[0]
        log.info(
            "Order %s payment %s: delta %s under one minor unit. %s",
            order["id"], payment_id, result["delta"],
            "Would capture remainder" if DRY_RUN else "Capturing remainder",
        )
        if not DRY_RUN:
            capture_remainder(token, payment_id, result["delta"])
        cleared += 1

    if not DRY_RUN:
        for order, pc, _ in to_clear:
            refreshed = get_order(token, order["id"])
            log.info("Order %s payment_status is now %s.", refreshed["id"], refreshed["payment_status"])

    log.info("Done. %d order(s) %s. %d flagged for review.", cleared,
             "to clear" if DRY_RUN else "cleared", len(to_flag))


if __name__ == "__main__":
    run()
