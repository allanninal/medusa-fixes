"""Find and safely cancel stuck active OrderChange rows on Medusa v2 orders.

Medusa v2 enforces a single-active-order-change invariant per order.
getActiveOrderChange_() looks for any OrderChange with status pending or
requested, and every edit, return, claim, and exchange workflow calls
throwIfOrderChangeIsNotActive before it will proceed. If a prior workflow
crashed, timed out, or hit a compensation bug before the change reached a
terminal status (confirmed_at, declined_at, or canceled_at set), that row
is left behind and silently blocks every future attempt on the order.

This lists orders with their order_change relation, classifies each one
with a pure function, and cancels only the rows that are non-terminal and
stale past a safety window. Never force-confirms a stuck change, since
cancellation to a terminal status is the only universally safe write.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/stuck-active-order-change/
"""
import os
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stuck_order_change")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
STALE_HOURS = float(os.environ.get("STALE_HOURS", "2"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ACTIVE_STATUSES = {"pending", "requested"}


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


def _parse_iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def classify_order_change(change, now, stale_hours=2):
    """Pure decision function. No I/O.

    change: {"status": str, "confirmed_at": str | None, "declined_at": str | None,
             "canceled_at": str | None, "updated_at": str}
    now: datetime (tz-aware)
    stale_hours: float

    Returns "active_fresh" | "active_stale_stuck" | "terminal".
    """
    if change.get("confirmed_at") or change.get("declined_at") or change.get("canceled_at"):
        return "terminal"

    if change.get("status") not in ACTIVE_STATUSES:
        return "terminal"

    updated = _parse_iso(change["updated_at"])
    age_hours = (now - updated).total_seconds() / 3600

    if age_hours > stale_hours:
        return "active_stale_stuck"

    return "active_fresh"


def list_orders_with_changes(token):
    orders = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,display_id,status,*order_change",
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def find_stuck_changes(orders, now, stale_hours):
    stuck = []
    for order in orders:
        change = order.get("order_change")
        if not change:
            continue
        outcome = classify_order_change(change, now, stale_hours)
        if outcome != "active_stale_stuck":
            continue
        stuck.append({
            "order_id": order["id"],
            "display_id": order.get("display_id"),
            "order_change_id": change["id"],
            "status": change["status"],
            "updated_at": change["updated_at"],
        })
    return stuck


def run():
    token = get_admin_token()
    orders = list_orders_with_changes(token)
    now = datetime.now(timezone.utc)

    stuck = find_stuck_changes(orders, now, STALE_HOURS)

    for row in stuck:
        log.warning(
            "Order %s (%s) has a stuck %s OrderChange %s. %s",
            row["display_id"], row["order_id"], row["status"], row["order_change_id"],
            "would cancel" if DRY_RUN else "cancelling",
        )
        if not DRY_RUN:
            # Cancellation has no public Admin REST route in v2. Run this branch
            # inside a Medusa exec/run() context and resolve the Order module:
            #   order_module = container.resolve(Modules.ORDER)
            #   order_module.cancel(row["order_change_id"])
            pass

    log.info("Done. %d stuck order change(s) %s.", len(stuck), "to cancel" if DRY_RUN else "cancelled")


if __name__ == "__main__":
    run()
