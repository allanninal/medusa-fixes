"""Find Medusa v2 fulfillments whose order.fulfillment_created event never fired.

createOrderFulfillmentWorkflow runs emitEventStep for order.fulfillment_created
near the end of its step graph, after the inventory reservation steps that only
touch line items whose variant has manage_inventory: true (tracked in
medusajs/medusa#10721). When every item on a fulfillment is untracked
inventory, those reservation steps have nothing to operate on, and the
workflow can finish before it reaches emitEventStep. The fulfillment record
is still created correctly, only the event, and anything that depended on
it like a shipment-notification email, is skipped silently.

This is a flag/report job, not an auto-fix: it never calls
POST /admin/orders/{id}/fulfillments again, since that would create a
duplicate fulfillment. By default it only reports the order_id/fulfillment_id
pairs it finds. With DRY_RUN=false it re-emits order.fulfillment_created
through your own event bus (call this from a Medusa exec script, see the
guide) and then flags the fulfillment as backfilled via a metadata patch so
the same one is never re-emitted twice.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/fulfillment-event-skipped-untracked-items/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missed_fulfillment_events")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

BACKFILL_FLAG = "fulfillment_created_event_backfilled"


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


def admin_post(token, path, body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def is_fulfillment_event_likely_missed(fulfillment, order_items_by_line_item_id, notified_fulfillment_ids):
    """Pure decision function. No I/O.

    fulfillment: {"id": str, "items": [{"line_item_id": str}]}
    order_items_by_line_item_id: {line_item_id: {"manage_inventory": bool}}
    notified_fulfillment_ids: set of fulfillment_id already covered by a notification.

    Returns True only when the fulfillment has no matching notification and
    every one of its items resolves to manage_inventory False, treating a
    missing lookup as untracked (conservative). A mixed fulfillment, or one
    that already has a notification, returns False.
    """
    if fulfillment["id"] in notified_fulfillment_ids:
        return False
    flags = [
        order_items_by_line_item_id.get(item["line_item_id"], {}).get("manage_inventory", False)
        for item in fulfillment["items"]
    ]
    return len(flags) > 0 and all(flag is False for flag in flags)


def list_orders_with_fulfillments(token):
    orders = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,*fulfillments,*items,items.variant.manage_inventory,*fulfillments.items",
            "order": "-created_at",
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def notified_fulfillment_ids(token):
    ids = set()
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/notifications", {
            "fields": "id,to,template,data",
            "order": "-created_at",
            "limit": limit,
            "offset": offset,
        })
        for n in data["notifications"]:
            fid = (n.get("data") or {}).get("fulfillment_id")
            if fid:
                ids.add(fid)
        offset += limit
        if offset >= data["count"]:
            return ids


def order_items_by_line_item_id(order):
    result = {}
    for item in order.get("items") or []:
        variant = item.get("variant") or {}
        result[item["id"]] = {"manage_inventory": bool(variant.get("manage_inventory", False))}
    return result


def mark_backfilled(token, order_id, fulfillment_id):
    return admin_post(
        token,
        f"/admin/orders/{order_id}/fulfillments/{fulfillment_id}",
        {"metadata": {BACKFILL_FLAG: True}},
    )


def reemit_fulfillment_created(order_id, fulfillment_id):
    # Re-emitting through the event bus has to happen inside the Medusa
    # process, where Modules.EVENT_BUS can be resolved. Call your Medusa
    # exec script here, for example:
    #   npx medusa exec ./src/scripts/backfill-exec.js <fulfillment_id> <order_id>
    log.info("Re-emit order.fulfillment_created for order=%s fulfillment=%s (run the Medusa exec script)", order_id, fulfillment_id)


def run():
    token = get_admin_token()
    orders = list_orders_with_fulfillments(token)
    notified = notified_fulfillment_ids(token)

    missed = 0
    for order in orders:
        items_by_id = order_items_by_line_item_id(order)
        for fulfillment in order.get("fulfillments") or []:
            if fulfillment.get("metadata", {}).get(BACKFILL_FLAG):
                continue
            if not is_fulfillment_event_likely_missed(fulfillment, items_by_id, notified):
                continue
            log.warning(
                "Order %s fulfillment %s likely missed order.fulfillment_created. %s",
                order["id"], fulfillment["id"],
                "would backfill" if DRY_RUN else "backfilling",
            )
            if not DRY_RUN:
                reemit_fulfillment_created(order["id"], fulfillment["id"])
                mark_backfilled(token, order["id"], fulfillment["id"])
            missed += 1

    log.info("Done. %d fulfillment(s) %s.", missed, "to backfill" if DRY_RUN else "backfilled")


if __name__ == "__main__":
    run()
