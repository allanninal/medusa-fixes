"""Find Medusa v2 draft orders that cannot get a payment collection through
the cart-centric store route, because a draft order never has a cart_id.
DRY_RUN=true (default) only reports the affected draft orders. Only when
DRY_RUN=false does it create the payment collection through the
order-linked workflow and mark it paid.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_draft_order_payment")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DRAFT_ORDER_FIELDS = "id,display_id,status,*summary,*payment_collections"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_draft_orders(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/draft-orders",
            params={"fields": DRAFT_ORDER_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["draft_orders"])
        offset += limit
        if offset >= body["count"]:
            return out


def decide_draft_order_payment_action(order):
    """Pure: no I/O. order has isDraftOrder, status, hasCartId,
    paymentCollections, pendingDifference."""
    if not order["isDraftOrder"]:
        return "OK"
    if order["status"] == "completed":
        return "OK"

    has_collection = len(order["paymentCollections"]) > 0
    if not has_collection and order["pendingDifference"] > 0:
        # Draft orders never have a real cart_id, so the cart-based
        # payment-collection creation path is structurally inapplicable;
        # route to the order-linked workflow instead of flagging a false
        # "missing cart" bug.
        if order["hasCartId"]:
            return "NEEDS_ORDER_PAYMENT_COLLECTION"
        return "FLAG_STUCK_NO_PAYMENT"

    return "OK"


def to_decision_input(raw_order):
    summary = raw_order.get("summary") or {}
    return {
        "isDraftOrder": True,
        "status": raw_order.get("status"),
        "hasCartId": False,
        "paymentCollections": raw_order.get("payment_collections") or [],
        "pendingDifference": float(summary.get("pending_difference") or 0),
    }


def create_order_payment_collection(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/draft-orders/{order_id}/payment-collections",
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["payment_collection"]


def mark_payment_collection_paid(token, payment_collection_id, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/payment-collections/{payment_collection_id}/mark-as-paid",
        json={"order_id": order_id},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    draft_orders = list_draft_orders(token)

    flagged = []
    for raw_order in draft_orders:
        action = decide_draft_order_payment_action(to_decision_input(raw_order))
        if action == "FLAG_STUCK_NO_PAYMENT":
            flagged.append(raw_order)

    if not flagged:
        log.info("No stuck draft orders found across %d draft order(s).", len(draft_orders))
        return

    for order in flagged:
        pending = (order.get("summary") or {}).get("pending_difference")
        log.warning(
            "Draft order %s (display #%s): no payment collection, pending_difference=%s. %s",
            order["id"], order.get("display_id"), pending,
            "Would create order-linked payment collection and mark paid" if DRY_RUN else "Repairing",
        )
        if not DRY_RUN:
            collection = create_order_payment_collection(token, order["id"])
            mark_payment_collection_paid(token, collection["id"], order["id"])

    log.info("Done. %d draft order(s) %s.", len(flagged), "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
