"""Flag Medusa orders whose fulfillment status is stuck on Delivered after a
full return and refund.

In Medusa v2, order.fulfillment_status is derived only from fulfillment
records, shipped and delivered quantities. Receiving a return through
receiveReturnWorkflow updates the Return's received quantities, and issuing a
refund updates the order's payment summary, but neither workflow recomputes
fulfillment_status. A fully returned, fully refunded order can sit forever
showing delivered as if the customer still has the goods. This lists orders
with items, fulfillments, and returns expanded, flags any order where every
fulfilled unit has a matching received unit on a completed return and the
refund covers it, and tags only those orders for review. It never writes
fulfillment_status directly.

Guide: https://www.allanninal.dev/medusa/fulfillment-status-stuck-delivered/
Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_stuck_fulfillment")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
REVIEW_TAG = os.environ.get("REVIEW_TAG", "returned-and-refunded")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

EPSILON = 0.01
STUCK_STATUSES = {"delivered", "partially_delivered"}

ORDER_FIELDS = "id,display_id,fulfillment_status,summary,*items,*returns,*returns.items"


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


def decide_fulfillment_repair(order):
    """Pure decision function. No I/O.

    order: {
      "id": str,
      "fulfillment_status": str,
      "summary": {"refunded_total": float},
      "items": [{"id": str, "quantity": float, "unit_price": float}],
      "returns": [{"status": str, "items": [{"item_id": str, "quantity": float}]}],
    }

    Returns {"orderId", "isStuck", "fulfilledQty", "receivedQty",
             "returnedValue", "refundedTotal", "reason"} where reason is one of
             "stuck_delivered" | "in_progress" | "not_returned".
    """
    items = order.get("items") or []
    fulfilled_qty = sum(item.get("quantity", 0) for item in items)
    price_by_item = {item.get("id"): item.get("unit_price", 0) for item in items}

    received_qty = 0.0
    returned_value = 0.0
    for ret in order.get("returns") or []:
        if ret.get("status") != "received":
            continue
        for line in ret.get("items") or []:
            qty = line.get("quantity", 0)
            received_qty += qty
            returned_value += qty * price_by_item.get(line.get("item_id"), 0)

    refunded_total = (order.get("summary") or {}).get("refunded_total", 0)
    status = order.get("fulfillment_status")

    if received_qty <= 0:
        reason = "not_returned"
        is_stuck = False
    elif received_qty + EPSILON < fulfilled_qty:
        reason = "in_progress"
        is_stuck = False
    elif refunded_total + EPSILON < returned_value:
        reason = "in_progress"
        is_stuck = False
    elif status in STUCK_STATUSES:
        reason = "stuck_delivered"
        is_stuck = True
    else:
        reason = "not_returned"
        is_stuck = False

    return {
        "orderId": order.get("id"),
        "isStuck": is_stuck,
        "fulfilledQty": fulfilled_qty,
        "receivedQty": received_qty,
        "returnedValue": returned_value,
        "refundedTotal": refunded_total,
        "reason": reason,
    }


def list_orders_with_returns(token):
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


def tag_returned_and_refunded(token, order_id, review_tag):
    return admin_post(token, f"/admin/orders/{order_id}", {
        "metadata": {review_tag: True},
    })


def run():
    token = get_admin_token()
    orders = list_orders_with_returns(token)

    flagged = 0
    for order in orders:
        outcome = decide_fulfillment_repair(order)
        if not outcome["isStuck"]:
            continue

        log.warning(
            "Order %s stuck on %s after a full return (fulfilled=%s received=%s refunded=%s). %s",
            order.get("display_id") or order["id"], order.get("fulfillment_status"),
            outcome["fulfilledQty"], outcome["receivedQty"], outcome["refundedTotal"],
            "would tag" if DRY_RUN else "tagging",
        )

        if not DRY_RUN:
            tag_returned_and_refunded(token, order["id"], REVIEW_TAG)

        flagged += 1

    log.info("Done. %d order(s) %s.", flagged, "to tag" if DRY_RUN else "tagged")


if __name__ == "__main__":
    run()
