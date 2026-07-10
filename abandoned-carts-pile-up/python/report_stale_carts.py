"""Find Medusa carts that piled up because they never converted to an order.

A Medusa v2 cart is a first-class, persistent record in the Cart Module, created as
soon as a shopper's session needs one and only marked complete by setting completed_at
when it converts into an order. Medusa ships no default scheduled job for cart
retention, so nothing expires, archives, or deletes a cart that never reaches checkout.
This lists carts, classifies each one with a pure function, cross-checks anything
flagged against real orders, and writes a report of stale cart_ids for manual review.
This is flag and report only. It never deletes a cart on its own.
Run on a schedule. Safe to run again and again.
"""
import os
import json
import logging
import requests
from datetime import datetime, timezone

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("report_stale_carts")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
STALE_DAYS = int(os.environ.get("STALE_DAYS", "30"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
REPORT_PATH = os.environ.get("REPORT_PATH", "stale_carts_report.json")


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


def _parse_iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def classify_stale_cart(cart, now, stale_days=30):
    """Pure decision function. No I/O.

    cart: {"id": str, "completed_at": str | None, "updated_at": str, "item_count": int}
    now: datetime, timezone aware
    stale_days: int

    Returns {"stale": bool, "reason": str}.
    """
    if cart.get("completed_at"):
        return {"stale": False, "reason": "completed"}

    age_days = (now - _parse_iso(cart["updated_at"])).total_seconds() / 86400

    if cart.get("item_count", 0) == 0:
        return {"stale": False, "reason": "empty-cart-not-abandoned"}

    if age_days >= stale_days:
        return {"stale": True, "reason": f"inactive-{int(age_days)}d-with-items"}

    return {"stale": False, "reason": "recent"}


def cart_total(cart):
    items = cart.get("items") or []
    return sum(float(i.get("unit_price", 0)) * float(i.get("quantity", 0)) for i in items)


def to_report_row(cart, age_days):
    items = cart.get("items") or []
    return {
        "cart_id": cart["id"],
        "email": cart.get("email") or cart.get("customer_id"),
        "region_id": cart.get("region_id"),
        "sales_channel_id": cart.get("sales_channel_id"),
        "item_count": len(items),
        "cart_total": cart_total(cart),
        "age_in_days": round(age_days, 1),
    }


def list_carts(token):
    carts = []
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/carts", {
            "fields": "id,email,customer_id,region_id,sales_channel_id,completed_at,created_at,updated_at,*items",
            "limit": limit,
            "offset": offset,
        })
        carts.extend(data["carts"])
        offset += limit
        if offset >= data["count"]:
            return carts


def completed_cart_ids(token):
    """Returns the set of cart_id values that have a matching order."""
    cart_ids = set()
    offset = 0
    limit = 200
    while True:
        data = admin_get(token, "/admin/orders", {
            "fields": "id,cart_id",
            "limit": limit,
            "offset": offset,
        })
        for order in data["orders"]:
            if order.get("cart_id"):
                cart_ids.add(order["cart_id"])
        offset += limit
        if offset >= data["count"]:
            return cart_ids


def delete_cart(token, cart_id):
    """Not called by run(). Kept for a team that explicitly opts into automated
    deletion, gated behind DRY_RUN, only for a cart_id confirmed to have no order.
    """
    return admin_delete(token, f"/admin/carts/{cart_id}")


def run():
    token = get_admin_token()
    carts = list_carts(token)
    confirmed_orders = completed_cart_ids(token)
    now = datetime.now(timezone.utc)

    report = []
    for cart in carts:
        items = cart.get("items") or []
        shaped = {
            "id": cart["id"],
            "completed_at": cart.get("completed_at"),
            "updated_at": cart.get("updated_at") or cart.get("created_at"),
            "item_count": len(items),
        }
        outcome = classify_stale_cart(shaped, now, STALE_DAYS)
        if not outcome["stale"]:
            continue
        if cart["id"] in confirmed_orders:
            log.info("Cart %s classified stale but has a matching order, skipping.", cart["id"])
            continue

        age_days = (now - _parse_iso(shaped["updated_at"])).total_seconds() / 86400
        row = to_report_row(cart, age_days)
        report.append(row)
        log.warning("Stale cart %s: %s, age=%.1fd, total=%s", row["cart_id"], outcome["reason"], age_days, row["cart_total"])

    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    log.info("Done. %d stale cart(s) written to %s. %s", len(report), REPORT_PATH,
              "(dry run, no deletes ever run from this script)" if DRY_RUN else "")


if __name__ == "__main__":
    run()
