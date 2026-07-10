"""Find Medusa draft orders that were created but never completed.

In Medusa v2 a draft order is an order with is_draft_order true and status "draft".
Completing it converts it into a real order. Nothing in the framework closes out a
draft order that a team started and then abandoned, so half-built quotes, test drafts,
and orders someone meant to finish later just sit in the store forever. This lists
draft orders, classifies each one with a pure function, and writes a report of the
stale ones (older than a threshold, still in draft) for manual review.
This is flag and report only. It never deletes a draft order on its own.
Run on a schedule. Safe to run again and again.
"""
import os
import json
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("report_stale_draft_orders")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
MAX_AGE_DAYS = int(os.environ.get("MAX_AGE_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "stale_draft_orders_report.json")


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


def admin_delete(token, path):
    r = requests.delete(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _parse_epoch(value):
    """Parse an ISO 8601 timestamp string into epoch seconds (UTC)."""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def is_stale_draft(order, now_epoch, max_age_days=30):
    """Pure decision function. No I/O.

    order: {"id": str, "status": str, "is_draft_order": bool, "created_at": str}
    now_epoch: float, current time in epoch seconds
    max_age_days: int

    Returns {"stale": bool, "reason": str}.
    """
    is_draft = order.get("is_draft_order") is True or order.get("status") == "draft"
    if not is_draft:
        return {"stale": False, "reason": "not-a-draft"}

    created = order.get("created_at")
    if not created:
        return {"stale": False, "reason": "no-created-at"}

    age_days = (now_epoch - _parse_epoch(created)) / 86400

    if age_days >= max_age_days:
        return {"stale": True, "reason": f"draft-{int(age_days)}d-never-completed"}

    return {"stale": False, "reason": "recent-draft"}


def order_total(order):
    total = order.get("total")
    if total is None:
        return 0.0
    return float(total)


def to_report_row(order, age_days):
    return {
        "draft_order_id": order["id"],
        "display_id": order.get("display_id"),
        "email": order.get("email") or order.get("customer_id"),
        "region_id": order.get("region_id"),
        "sales_channel_id": order.get("sales_channel_id"),
        "currency_code": order.get("currency_code"),
        "total": order_total(order),
        "age_in_days": round(age_days, 1),
    }


def list_draft_orders(token):
    orders = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/draft-orders", {
            "fields": "id,display_id,status,is_draft_order,email,customer_id,region_id,sales_channel_id,currency_code,total,created_at,updated_at",
            "limit": limit,
            "offset": offset,
        })
        orders.extend(data["draft_orders"])
        offset += limit
        if offset >= data["count"]:
            return orders


def delete_draft_order(token, draft_order_id):
    """Not called by run(). Kept for a team that explicitly opts into automated
    cleanup, gated behind DRY_RUN, only for a draft confirmed stale and reviewed.
    """
    return admin_delete(token, f"/admin/draft-orders/{draft_order_id}")


def run():
    token = get_admin_token()
    drafts = list_draft_orders(token)
    now_epoch = datetime.now(timezone.utc).timestamp()

    report = []
    for order in drafts:
        shaped = {
            "id": order["id"],
            "status": order.get("status"),
            "is_draft_order": order.get("is_draft_order"),
            "created_at": order.get("created_at"),
        }
        outcome = is_stale_draft(shaped, now_epoch, MAX_AGE_DAYS)
        if not outcome["stale"]:
            continue

        age_days = (now_epoch - _parse_epoch(shaped["created_at"])) / 86400
        row = to_report_row(order, age_days)
        report.append(row)
        log.warning("Stale draft %s: %s, age=%.1fd, total=%s", row["draft_order_id"], outcome["reason"], age_days, row["total"])

    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    log.info("Done. %d stale draft order(s) written to %s. %s", len(report), REPORT_PATH,
              "(dry run, no deletes ever run from this script)" if DRY_RUN else "")


if __name__ == "__main__":
    run()
