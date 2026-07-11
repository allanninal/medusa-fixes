"""Find Medusa v2 orders where a confirmed order edit canceled the payment
collection and left no capturable collection behind, while the order still
owes money. This is not auto-fixable: there is no supported route to
un-cancel a payment_collection. DRY_RUN=true (default) only reports the
affected orders. Only when DRY_RUN=false and a human has reviewed the
amount should a new payment collection be created and captured against.

Guide: https://www.allanninal.dev/medusa/order-edit-cancels-payment-collection/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_edit_cancels_payment")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
PAYMENT_PROVIDER_ID = os.environ.get("MEDUSA_PAYMENT_PROVIDER_ID", "pp_system_default")

ORDER_FIELDS = (
    "id,display_id,status,payment_status,*summary,"
    "*payment_collections,*order_change"
)
EDIT_CHANGE_STATUSES = {"requested", "confirmed"}
CAPTURABLE_STATUSES = {"not_paid", "awaiting", "authorized", "partially_authorized"}


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def has_confirmed_edit(order):
    change = order.get("order_change") or {}
    return (
        change.get("change_type") == "edit"
        and change.get("status") in EDIT_CHANGE_STATUSES
    )


def list_edited_orders(token):
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
        out.extend(o for o in body["orders"] if has_confirmed_edit(o))
        offset += limit
        if offset >= body["count"]:
            return out


def classify_order_payment_edit_state(order):
    """Pure: no I/O. order has payment_status, payment_collections, summary.

    Returns {blocked, reason, canceledCollectionId, amountDue}. blocked is
    True only when payment_status is not_paid, no payment_collection has a
    capturable status, at least one payment_collection is canceled, and the
    outstanding amount is greater than 0.
    """
    if order.get("payment_status") != "not_paid":
        return {"blocked": False, "reason": None, "canceledCollectionId": None, "amountDue": 0}

    collections = order.get("payment_collections") or []
    has_capturable = any(pc.get("status") in CAPTURABLE_STATUSES for pc in collections)
    canceled = next((pc for pc in collections if pc.get("status") == "canceled"), None)

    summary = order.get("summary") or {}
    amount_due = summary.get("raw_difference_due")
    if amount_due is None:
        amount_due = sum(
            pc.get("amount", 0) for pc in collections if pc.get("status") != "captured"
        )

    if not has_capturable and canceled is not None and amount_due > 0:
        return {
            "blocked": True,
            "reason": "canceled_collection_blocks_capture",
            "canceledCollectionId": canceled.get("id"),
            "amountDue": amount_due,
        }

    return {"blocked": False, "reason": None, "canceledCollectionId": None, "amountDue": 0}


def create_payment_collection(token, order_id, amount):
    """Documented, supported route for attaching a new collection to an
    order missing a capturable one. Never call this against the canceled
    collection's id, this always creates a brand new one.
    """
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/orders/{order_id}/payment-collections",
        json={"amount": amount},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["payment_collection"]


def create_payment_session(token, collection_id, provider_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/payment-collections/{collection_id}/payment-sessions",
        json={"provider_id": provider_id},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def capture_payment(token, payment_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/payments/{payment_id}/capture",
        json={},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    orders = list_edited_orders(token)

    flagged = []
    for order in orders:
        result = classify_order_payment_edit_state(order)
        if result["blocked"]:
            flagged.append((order, result))

    if not flagged:
        log.info("No blocked orders found across %d edited order(s).", len(orders))
        return

    for order, result in flagged:
        log.warning(
            "Order %s (display #%s): canceled_collection=%s amount_due=%s. %s",
            order["id"], order.get("display_id"), result["canceledCollectionId"],
            result["amountDue"],
            "Would report only" if DRY_RUN else "Reported, awaiting operator action",
        )
        if not DRY_RUN:
            # This script intentionally never auto-creates a payment collection
            # or auto-captures. An operator must confirm the amount against
            # order.summary.raw_difference_due first, then call
            # create_payment_collection(), create_payment_session(), and
            # capture_payment() explicitly, one order at a time.
            log.warning(
                "Order %s: DRY_RUN is off, but this script never auto-creates a "
                "payment collection. Confirm amount_due=%s against "
                "order.summary.raw_difference_due, then call "
                "create_payment_collection() and create_payment_session() by hand.",
                order["id"], result["amountDue"],
            )

    log.info("Done. %d order(s) blocked by a canceled payment collection.", len(flagged))


if __name__ == "__main__":
    run()
