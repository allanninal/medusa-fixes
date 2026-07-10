"""Flag Medusa orders that are paid but still not fulfilled past your SLA.

In Medusa v2, placing an order and fulfilling an order are decoupled. Capturing
a payment only updates payment_status. Nothing forces a fulfillment to be
created, so an order can sit with fulfillment_status "not_fulfilled" (or
"partially_fulfilled") indefinitely if the automation that should create a
fulfillment, an order.placed subscriber, a scheduled job, or a warehouse
integration, silently fails. This is worse in production when the default
in-memory Event Bus and Workflow Engine modules are used instead of their
Redis-backed equivalents, because events and job runs do not persist across
process restarts or multiple instances.

The Admin API cannot filter orders server-side by fulfillment_status or
payment_status, so this pages through orders and computes the SLA breach
client-side. It never creates a fulfillment. Picking, packing, and shipping
are real-world actions this script cannot safely fabricate. It only patches
metadata to flag a breached order for human review, and only when DRY_RUN is
off. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_sla_breached_orders")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
SLA_HOURS = float(os.environ.get("SLA_HOURS", "48"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

UNFULFILLED_STATUSES = {"not_fulfilled", "partially_fulfilled"}

ORDER_FIELDS = (
    "id,display_id,email,created_at,status,fulfillment_status,payment_status,"
    "*payment_collections,*fulfillments,metadata"
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


def admin_post(token, path, body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _is_paid(order):
    if order.get("payment_status") == "captured":
        return True
    collections = order.get("payment_collections") or []
    if collections:
        return all(pc.get("status") == "captured" for pc in collections)
    return False


def _is_unfulfilled(order):
    if order.get("fulfillment_status") in UNFULFILLED_STATUSES:
        return True
    return len(order.get("fulfillments") or []) == 0


def evaluate_order_sla(order, now_ms, sla_hours):
    """Pure decision function. No I/O.

    order: {status, payment_status, fulfillment_status, fulfillments?, created_at,
            metadata?}
    now_ms: current time in epoch milliseconds (passed in, not read from the clock)
    sla_hours: hours after which a paid, unfulfilled order is considered breached

    Returns {breached, already_flagged, age_hours, reason?}.
    """
    metadata = order.get("metadata") or {}
    already_flagged = metadata.get("sla_flagged") is True

    created_at = order.get("created_at")
    if not created_at:
        return {"breached": False, "already_flagged": already_flagged, "age_hours": 0.0, "reason": "missing created_at"}

    created_ms = _parse_iso_to_ms(created_at)
    age_hours = (now_ms - created_ms) / 3_600_000

    if order.get("status") == "canceled":
        return {"breached": False, "already_flagged": already_flagged, "age_hours": age_hours, "reason": "canceled"}

    is_paid = _is_paid(order)
    is_unfulfilled = _is_unfulfilled(order)

    if already_flagged:
        return {"breached": False, "already_flagged": True, "age_hours": age_hours, "reason": "already flagged"}
    if not is_paid:
        return {"breached": False, "already_flagged": False, "age_hours": age_hours, "reason": "not paid"}
    if not is_unfulfilled:
        return {"breached": False, "already_flagged": False, "age_hours": age_hours, "reason": "already fulfilled"}
    if age_hours <= sla_hours:
        return {"breached": False, "already_flagged": False, "age_hours": age_hours, "reason": "within SLA"}

    return {"breached": True, "already_flagged": False, "age_hours": age_hours}


def _parse_iso_to_ms(iso):
    from datetime import datetime
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def list_orders(token):
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


def flag_order(token, order):
    metadata = dict(order.get("metadata") or {})
    metadata["sla_flagged"] = True
    metadata["sla_flagged_at"] = _now_iso()
    metadata["sla_breach_hours"] = int(evaluate_order_sla(order, _now_ms(), SLA_HOURS)["age_hours"])
    return admin_post(token, f"/admin/orders/{order['id']}", {"metadata": metadata})


def _now_ms():
    import time
    return time.time() * 1000


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def run():
    token = get_admin_token()
    now_ms = _now_ms()

    flagged = 0
    for order in list_orders(token):
        result = evaluate_order_sla(order, now_ms, SLA_HOURS)
        if not result["breached"]:
            continue
        log.warning(
            "Order %s (%s) breached SLA: paid but %s for %.1fh. %s",
            order.get("display_id"), order["id"], order.get("fulfillment_status"),
            result["age_hours"], "would flag" if DRY_RUN else "flagging",
        )
        if not DRY_RUN:
            flag_order(token, order)
        flagged += 1

    log.info("Done. %d order(s) %s.", flagged, "to flag" if DRY_RUN else "flagged")


if __name__ == "__main__":
    run()
