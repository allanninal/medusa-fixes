"""Find Medusa v2 orders where a captured payment plus a pending or
confirmed order edit reports the balance direction backwards, refund
owed reported as collect, or the reverse. This is not auto-fixable: it
is a computed field bug in Medusa core (GitHub issues #13068, #13067),
not corrupted data. DRY_RUN=true (default) only reports the affected
orders. Only when DRY_RUN=false and a human has reviewed the direction
does the script add an internal_note to the order edit, never a
capture or refund call.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_wrong_balance_direction")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

ORDER_FIELDS = "id,display_id,status,*summary,*items,*order_change"
EDIT_CHANGE_STATUSES = {"requested", "confirmed"}

NOTE_TEMPLATE = (
    "Suspected reversed refund-direction bug (medusajs/medusa#13068) "
    "-- verify manually before force-confirming or capturing/refunding payment. "
    "recomputed_direction={direction} pending_difference={pending_difference}"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def has_relevant_edit(order):
    change = order.get("order_change") or {}
    return (
        change.get("change_type") == "edit"
        and change.get("status") in EDIT_CHANGE_STATUSES
    )


def list_paid_edited_orders(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/orders",
            params={"fields": ORDER_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for o in body["orders"]:
            summary = o.get("summary") or {}
            if summary.get("paid_total", 0) > 0 and has_relevant_edit(o):
                out.append(o)
        offset += limit
        if offset >= body["count"]:
            return out


def decide_balance_action(current_order_total, paid_total):
    """Pure: no I/O. pending_difference semantics per Medusa OrderSummary:
    current_order_total - paid_total. Negative means refund owed to the
    customer, positive means more is owed by the customer."""
    diff = float(current_order_total) - float(paid_total)
    if diff == 0:
        return {"pendingDifference": 0.0, "direction": "none"}
    if diff < 0:
        return {"pendingDifference": diff, "direction": "refund"}
    return {"pendingDifference": diff, "direction": "collect"}


def reported_direction(order):
    """Read the direction the app/UI is currently using, from the order's
    own summary.pending_difference, the exact field the bug can flip."""
    summary = order.get("summary") or {}
    reported = summary.get("pending_difference")
    if reported is None:
        return None
    if reported == 0:
        return "none"
    return "refund" if reported < 0 else "collect"


def add_internal_note(token, order_edit_id, note):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/order-edits/{order_edit_id}",
        json={"internal_note": note},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = get_token()
    orders = list_paid_edited_orders(token)

    flagged = []
    for order in orders:
        summary = order.get("summary") or {}
        expected = decide_balance_action(
            summary.get("current_order_total", 0), summary.get("paid_total", 0)
        )
        reported = reported_direction(order)
        if reported is not None and reported != expected["direction"]:
            flagged.append((order, expected, reported))

    if not flagged:
        log.info("No direction mismatches found across %d paid, edited order(s).", len(orders))
        return

    for order, expected, reported in flagged:
        change = order.get("order_change") or {}
        order_edit_id = change.get("id")
        summary = order.get("summary") or {}
        log.warning(
            "Order %s (display #%s): reported=%s expected=%s paid_total=%s "
            "current_order_total=%s pending_difference=%s. %s",
            order["id"], order.get("display_id"), reported, expected["direction"],
            summary.get("paid_total"), summary.get("current_order_total"),
            expected["pendingDifference"],
            "Would report only" if DRY_RUN else "Reported, adding internal note",
        )
        if not DRY_RUN and order_edit_id:
            note = NOTE_TEMPLATE.format(
                direction=expected["direction"],
                pending_difference=expected["pendingDifference"],
            )
            add_internal_note(token, order_edit_id, note)

    log.info("Done. %d order(s) flagged with a mismatched balance direction.", len(flagged))


if __name__ == "__main__":
    run()
