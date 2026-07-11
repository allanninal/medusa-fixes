"""Find Medusa v2 orders whose expected notification, such as order.placed,
never fired because the subscriber attached to that event threw, hung, or
failed to resolve a service without surfacing anywhere the order itself can
show. Never re-emits the raw event and never fabricates historical
notifications. DRY_RUN=true only reports the flagged orders. Safe to run
again and again, because repair is guarded by an idempotency check against
the Notification module's own log.
"""
import os
import logging
from datetime import datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_notifications")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
EXPECTED_EVENT = os.environ.get("EXPECTED_EVENT", "order.placed")
GRACE_MINUTES = float(os.environ.get("GRACE_MINUTES", "10"))

ORDER_FIELDS = "id,display_id,status,fulfillment_status,payment_status,created_at,*customer"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_recent_orders(token, limit=100):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset = [], 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/orders",
            params={"fields": ORDER_FIELDS, "limit": limit, "offset": offset, "order": "-created_at"},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["orders"])
        offset += limit
        if offset >= body["count"]:
            return out


def list_notifications_for_order(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/notifications",
        params={"resource_id": order_id, "resource_type": "order", "limit": 50},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["notifications"]


def find_orders_missing_notification(orders, notifications, expected_event, grace_ms, now_ms):
    """Pure: no I/O. orders and notifications are plain dicts/lists already fetched."""
    notified_ids = {
        n["resource_id"]
        for n in notifications
        if n.get("resource_type") == "order" and n.get("event_name") == expected_event
    }

    flagged = []
    for order in orders:
        created_ms = datetime.fromisoformat(
            order["created_at"].replace("Z", "+00:00")
        ).timestamp() * 1000
        if (now_ms - created_ms) > grace_ms and order["id"] not in notified_ids:
            flagged.append({"order_id": order["id"], "expected_event": expected_event})
    return flagged


def already_notified(token, order_id, expected_event):
    notifications = list_notifications_for_order(token, order_id)
    return any(n.get("event_name") == expected_event for n in notifications)


def retrigger_order_confirmation(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/orders/{order_id}/resend-confirmation",
        json={},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    orders = list_recent_orders(token)

    all_notifications = []
    for order in orders:
        all_notifications.extend(list_notifications_for_order(token, order["id"]))

    now_ms = datetime.now().timestamp() * 1000
    grace_ms = GRACE_MINUTES * 60 * 1000
    flagged = find_orders_missing_notification(orders, all_notifications, EXPECTED_EVENT, grace_ms, now_ms)

    if not flagged:
        log.info("No orders missing %s across %d order(s).", EXPECTED_EVENT, len(orders))
        return

    by_id = {o["id"]: o for o in orders}
    for item in flagged:
        order = by_id[item["order_id"]]
        customer = order.get("customer") or {}
        log.warning(
            "Order %s (display_id=%s) missing %s since %s. customer_email=%s",
            order["id"], order.get("display_id"), item["expected_event"],
            order["created_at"], customer.get("email"),
        )

    if not DRY_RUN:
        for item in flagged:
            order_id = item["order_id"]
            if already_notified(token, order_id, item["expected_event"]):
                log.info("Order %s already notified since the scan ran. Skipping.", order_id)
                continue
            log.info("Order %s: re-triggering %s.", order_id, item["expected_event"])
            retrigger_order_confirmation(token, order_id)

    log.info("Done. %d order(s) %s.", len(flagged), "to review" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
