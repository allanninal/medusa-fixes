"""Find Medusa v2 orders whose order.placed event never reached its
subscriber because the Redis Event Bus Module (BullMQ) queued the job
before a worker's subscriber-loader finished, or a worker restarted,
autoscaled, or crashed mid-job. Classifies every order in the window as
delivered, delayed, or dropped by diffing against the Notification
module's own delivery log. Never mutates orders or notifications.
DRY_RUN=true only writes audit records for confirmed drops. Re-emitting
through the workflow engine is manual, opt-in, and gated behind an
explicit confirmation list built by a human from the audit output.

Guide: https://www.allanninal.dev/medusa/redis-event-bus-drops-events/
"""
import os
import logging
from datetime import datetime, timedelta, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_event_delivery")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
WINDOW_HOURS = float(os.environ.get("WINDOW_HOURS", "24"))
DELAY_THRESHOLD_MS = float(os.environ.get("DELAY_THRESHOLD_MS", "60000"))
# Comma-separated order_id values a human has confirmed should be re-emitted.
CONFIRMED_REEMIT_IDS = {
    x.strip() for x in os.environ.get("CONFIRMED_REEMIT_IDS", "").split(",") if x.strip()
}

ORDER_FIELDS = "id,display_id,status,created_at,*fulfillments"
NOTIFICATION_FIELDS = "id,to,channel,template,trigger_type,resource_id,resource_type,event_name,original_notification_id,created_at"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_orders_since(token, window_start, limit=200):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset = [], 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/orders",
            params={
                "created_at[$gte]": window_start,
                "fields": ORDER_FIELDS,
                "limit": limit,
                "offset": offset,
            },
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["orders"])
        offset += limit
        if offset >= body["count"]:
            return out


def list_notifications_since(token, window_start, limit=200):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset = [], 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/notifications",
            params={
                "created_at[$gte]": window_start,
                "fields": NOTIFICATION_FIELDS,
                "limit": limit,
                "offset": offset,
            },
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["notifications"])
        offset += limit
        if offset >= body["count"]:
            return out


def _to_ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def diff_event_delivery(orders, notifications, window_start, window_end, delay_threshold_ms=60000):
    """Pure: no I/O. orders and notifications are plain dicts/lists already fetched.

    For each order, finds the earliest notification with resource_type "order",
    matching resource_id, and event_name "order.placed". No match means the
    status is "dropped" (delay_ms is None). A match means "delayed" if the gap
    between order.created_at and notification.created_at exceeds
    delay_threshold_ms, otherwise "delivered".
    """
    by_order = {}
    for n in notifications:
        if n.get("resource_type") != "order" or n.get("event_name") != "order.placed":
            continue
        rid = n.get("resource_id")
        ts = _to_ms(n["created_at"])
        if rid not in by_order or ts < by_order[rid]:
            by_order[rid] = ts

    results = []
    for order in orders:
        order_id = order["id"]
        created_ms = _to_ms(order["created_at"])
        match_ms = by_order.get(order_id)
        if match_ms is None:
            results.append({"order_id": order_id, "status": "dropped", "delay_ms": None})
            continue
        delay_ms = match_ms - created_ms
        status = "delayed" if delay_ms > delay_threshold_ms else "delivered"
        results.append({"order_id": order_id, "status": status, "delay_ms": delay_ms})
    return results


def write_audit_record(order_id, display_id, window_start, window_end, elapsed_ms):
    record = {
        "order_id": order_id,
        "display_id": display_id,
        "expected_event": "order.placed",
        "window_start": window_start,
        "window_end": window_end,
        "elapsed_ms_since_created": elapsed_ms,
    }
    log.warning("DROPPED %s", record)
    return record


def reemit_order_placed(token, order_id):
    """Manual, opt-in only. Re-triggers every subscriber attached to order.placed.

    Assumes a small custom workflow named reemit-order-placed is registered in
    the Medusa app that calls emitEventStep({ eventName: "order.placed",
    data: { id: order.id } }) from @medusajs/medusa/core-flows.
    """
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/workflows/reemit-order-placed/run",
        json={"input": {"order_id": order_id}},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    now = datetime.now(timezone.utc)
    window_start = (now - timedelta(hours=WINDOW_HOURS)).isoformat()
    window_end = now.isoformat()

    orders = list_orders_since(token, window_start)
    notifications = list_notifications_since(token, window_start)
    by_id = {o["id"]: o for o in orders}

    results = diff_event_delivery(orders, notifications, window_start, window_end, DELAY_THRESHOLD_MS)
    dropped = [r for r in results if r["status"] == "dropped"]
    delayed = [r for r in results if r["status"] == "delayed"]

    log.info(
        "Window %s to %s: %d order(s), %d delivered, %d delayed, %d dropped.",
        window_start, window_end, len(orders), len(results) - len(delayed) - len(dropped),
        len(delayed), len(dropped),
    )

    for item in dropped:
        order = by_id[item["order_id"]]
        elapsed_ms = _to_ms(window_end) - _to_ms(order["created_at"])
        write_audit_record(order["id"], order.get("display_id"), window_start, window_end, elapsed_ms)

    if not DRY_RUN:
        for item in dropped:
            order_id = item["order_id"]
            if order_id not in CONFIRMED_REEMIT_IDS:
                log.info("Order %s dropped but not on the confirmed re-emit list. Skipping.", order_id)
                continue
            log.warning("Order %s: re-emitting order.placed via the workflow engine.", order_id)
            reemit_order_placed(token, order_id)

    log.info("Done. %d dropped order(s) %s.", len(dropped), "audited" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
