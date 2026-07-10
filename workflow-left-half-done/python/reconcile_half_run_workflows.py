"""Reconcile Medusa reservations left behind by a workflow that never finished.

Medusa v2 workflows are sagas: each step's rollback is opt-in through a compensation
function passed to createStep, so a step without one, such as createRemoteLinkStep
(GitHub #9844), leaves its side effect in place if a later step throws. Separately, a
crashed process or the in-memory Workflow Engine used in production means the saga
never reaches the compensating phase at all, so an already-committed reservation from
reserveInventoryStep stays committed while workflow_execution is stuck in a
non-terminal state (GitHub #9077, #12913, #11266).

This lists reservations, resolves each line_item_id's parent order, classifies each
reservation with a pure function, and deletes only the unambiguous orphan cases:
an order that no longer resolves (404) or an order whose status is canceled.
Everything else is reported only. Run on a schedule. Safe to run again and again.
"""
import os
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_half_run_workflows")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
STALE_MINUTES = float(os.environ.get("STALE_MINUTES", "10"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DELETABLE = {"orphaned_no_order", "orphaned_canceled_order"}


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


def _parse_iso_ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def classify_reservation(reservation, order, now_iso, stale_minutes=10):
    """Pure decision function. No I/O.

    reservation: {"id": str, "line_item_id": str | None, "created_at": str (ISO)}
    order: {"id": str, "status": str} | None
    now_iso: str (ISO timestamp)
    stale_minutes: int

    Returns "orphaned_no_order" | "orphaned_canceled_order" |
            "stale_pending_review" | "healthy".
    """
    if reservation.get("line_item_id") is None:
        return "healthy"

    if order is None:
        return "orphaned_no_order"

    if order.get("status") == "canceled":
        return "orphaned_canceled_order"

    age_ms = _parse_iso_ms(now_iso) - _parse_iso_ms(reservation["created_at"])
    if age_ms > stale_minutes * 60000 and order.get("status") not in ("pending", "completed"):
        return "stale_pending_review"

    return "healthy"


def list_reservations(token):
    reservations = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/reservations", {
            "fields": "id,line_item_id,inventory_item_id,location_id,quantity,created_at,*line_item.order_id",
            "limit": limit,
            "offset": offset,
        })
        reservations.extend(data["reservations"])
        offset += limit
        if offset >= data["count"]:
            return reservations


def get_order_or_none(token, order_id):
    if not order_id:
        return None
    r = requests.get(
        f"{BACKEND_URL}/admin/orders/{order_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,status"},
        timeout=30,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()["order"]


def run():
    token = get_admin_token()
    reservations = list_reservations(token)
    now_iso = datetime.now(timezone.utc).isoformat()

    deleted = 0
    reported = 0
    for reservation in reservations:
        line_item = reservation.get("line_item") or {}
        order_id = line_item.get("order_id")
        order = get_order_or_none(token, order_id) if reservation.get("line_item_id") else None

        outcome = classify_reservation(reservation, order, now_iso, STALE_MINUTES)
        if outcome == "healthy":
            continue

        if outcome in DELETABLE:
            log.warning(
                "Reservation %s classified as %s. order_id=%s. %s",
                reservation["id"], outcome, order_id, "Would delete" if DRY_RUN else "Deleting",
            )
            if not DRY_RUN:
                admin_delete(token, f"/admin/reservations/{reservation['id']}")
            deleted += 1
        else:
            log.info(
                "Reservation %s reported as %s. order_id=%s status=%s (needs human review, not touched).",
                reservation["id"], outcome, order_id, (order or {}).get("status"),
            )
            reported += 1

    log.info(
        "Done. %d reservation(s) %s, %d reservation(s) reported for review.",
        deleted, "to delete" if DRY_RUN else "deleted", reported,
    )


if __name__ == "__main__":
    run()
