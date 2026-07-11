"""Find Medusa v2 orders that received more than one order confirmation
notification because order.placed fired, or was acted on, more than once.

The usual cause is a leftover workaround subscriber that manually called
capturePaymentWorkflow to patch an old payment-status bug (Medusa issues
#11766 and #13301), left running unconditionally after Medusa v2.11.1 fixed
those bugs upstream. This script only reads orders and notifications, and
only ever reports, DRY_RUN=true or not, because Notification records are an
audit trail and must never be resent or deleted automatically. Repairing the
leftover subscriber file (deleting or version-gating the src/subscribers
file that still calls capturePaymentWorkflow on order.placed) is a separate,
code-level step that belongs in your own migration/cleanup script, guarded
by its own DRY_RUN flag, per the Medusa docs on the filesystem-based
subscriber model: https://docs.medusajs.com/learn/fundamentals/events-and-subscribers
"""
import os
import logging
from datetime import datetime
from collections import defaultdict

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_confirmations")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
WINDOW_MS = int(os.environ.get("DUPLICATE_WINDOW_MS", "60000"))
ORDER_LIMIT = int(os.environ.get("ORDER_LIMIT", "100"))

ORDER_FIELDS = "id,display_id,email,created_at"
NOTIFICATION_FIELDS = "id,to,resource_id,resource_type,created_at,data"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_recent_orders(token, limit=ORDER_LIMIT):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/orders",
        params={"fields": ORDER_FIELDS, "limit": limit, "order": "-created_at"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["orders"]


def list_notifications_for_order(token, order_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/notifications",
        params={"resource_id": order_id, "fields": NOTIFICATION_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["notifications"]


def find_duplicate_notifications(notifications, window_ms=60000):
    """Pure: no I/O. notifications is a plain list already fetched.

    Group order-related notifications by resource_id (order_id), sort by
    created_at, then cluster consecutive sends to the same recipient within
    `window_ms` of each other. Any cluster with size > 1 is a duplicate-send
    incident caused by order.placed firing more than once for the same
    order (e.g. a leftover re-emitting subscriber). Returns one entry per
    order_id that has at least one duplicate cluster, with the full set of
    notification ids involved in that cluster for downstream reporting.
    """
    by_order = defaultdict(list)
    for n in notifications:
        if n.get("resource_type") != "order":
            continue
        by_order[n["resource_id"]].append(n)

    results = []
    for order_id, group in by_order.items():
        group.sort(key=lambda n: n["created_at"])
        cluster = [group[0]]
        clusters = []
        for prev, cur in zip(group, group[1:]):
            same_recipient = prev.get("to") == cur.get("to")
            gap_ms = (
                datetime.fromisoformat(cur["created_at"].replace("Z", "+00:00")).timestamp()
                - datetime.fromisoformat(prev["created_at"].replace("Z", "+00:00")).timestamp()
            ) * 1000
            if same_recipient and gap_ms <= window_ms:
                cluster.append(cur)
            else:
                clusters.append(cluster)
                cluster = [cur]
        clusters.append(cluster)

        for c in clusters:
            if len(c) > 1:
                results.append({
                    "order_id": order_id,
                    "count": len(c),
                    "notification_ids": [n["id"] for n in c],
                })
    return results


def run():
    token = get_token()
    orders = list_recent_orders(token)
    orders_by_id = {o["id"]: o for o in orders}

    all_notifications = []
    for order in orders:
        all_notifications.extend(list_notifications_for_order(token, order["id"]))

    duplicates = find_duplicate_notifications(all_notifications, WINDOW_MS)

    if not duplicates:
        log.info("No duplicate confirmation notifications across %d order(s).", len(orders))
        return

    for dup in duplicates:
        order = orders_by_id.get(dup["order_id"], {})
        log.warning(
            "DRY_RUN report: order %s (display_id=%s) got %d confirmation notifications. ids=%s",
            dup["order_id"], order.get("display_id"), dup["count"], dup["notification_ids"],
        )

    log.info(
        "Done. %d order(s) with duplicate confirmation sends. Report only, DRY_RUN=%s. "
        "No notification was resent or deleted. The code fix is removing or gating the "
        "leftover order.placed subscriber that calls capturePaymentWorkflow.",
        len(duplicates), DRY_RUN,
    )


if __name__ == "__main__":
    run()
