"""Flag and safely repair Medusa v2 open carts still holding a stale unit_price
after a variant or price list change. Never touches is_custom_price line items,
never bulk overwrites. DRY_RUN=true only logs old vs new price. Safe to run again
and again, one cart at a time.

Guide: https://www.allanninal.dev/medusa/stale-cart-prices-after-a-price-change/
"""
import os
import logging
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_stale_cart_prices")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CART_FIELDS = (
    "id,updated_at,completed_at,currency_code,region_id,"
    "*line_items,line_items.unit_price,line_items.is_custom_price,"
    "line_items.variant_id,line_items.updated_at"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_open_carts(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/carts",
            params={"fields": CART_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(c for c in body["carts"] if c.get("completed_at") is None)
        offset += limit
        if offset >= body["count"]:
            return out


def get_variant_prices(token, product_id, variant_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/products/{product_id}/variants/{variant_id}",
        params={"fields": "id,*prices"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["variant"]["prices"]


def build_live_price_map(token, variant_product_pairs, now_iso):
    live_prices = {}
    for variant_id, product_id in variant_product_pairs:
        for p in get_variant_prices(token, product_id, variant_id):
            region_id = (p.get("rules") or {}).get("region_id")
            key = f"{variant_id}:{p['currency_code']}:{region_id}"
            live_prices[key] = {
                "amount": p["amount"],
                "currency_code": p["currency_code"],
                "region_id": region_id,
                "updated_at": now_iso,
            }
    return live_prices


def find_stale_cart_line_items(carts, live_prices):
    """Pure: no I/O. carts is a list of open cart dicts with line_items.
    live_prices is a dict keyed by "variant_id:currency_code:region_id"."""
    flagged = []
    for cart in carts:
        if cart.get("completed_at") is not None:
            continue
        for item in cart.get("line_items", []):
            if item.get("is_custom_price"):
                continue
            key = f"{item['variant_id']}:{cart['currency_code']}:{cart['region_id']}"
            live = live_prices.get(key)
            if live is None:
                continue
            if live["amount"] == item["unit_price"]:
                continue
            if item["updated_at"] >= live["updated_at"]:
                continue
            flagged.append({
                "cart_id": cart["id"],
                "line_item_id": item["id"],
                "old_price": item["unit_price"],
                "new_price": live["amount"],
            })
    return flagged


def force_recompute(token, cart_id, line_item_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/carts/{cart_id}/line-items/{line_item_id}",
        json={},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def get_cart(token, cart_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/carts/{cart_id}",
        params={"fields": CART_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def run():
    token = get_token()
    carts = list_open_carts(token)

    variant_product_pairs = set()
    for cart in carts:
        for item in cart.get("line_items", []):
            product_id = item.get("product_id")
            if product_id:
                variant_product_pairs.add((item["variant_id"], product_id))

    now_iso = datetime.now(timezone.utc).isoformat()
    live_prices = build_live_price_map(token, variant_product_pairs, now_iso)

    flagged = find_stale_cart_line_items(carts, live_prices)
    if not flagged:
        log.info("No stale cart line items found across %d open cart(s).", len(carts))
        return

    for f in flagged:
        log.info(
            "Cart %s line item %s: old_price=%s new_price=%s. %s",
            f["cart_id"], f["line_item_id"], f["old_price"], f["new_price"],
            "Would repair" if DRY_RUN else "Repairing",
        )
        if not DRY_RUN:
            force_recompute(token, f["cart_id"], f["line_item_id"])
            refreshed = get_cart(token, f["cart_id"])
            confirmed = any(
                li["id"] == f["line_item_id"] and li["unit_price"] == f["new_price"]
                for li in refreshed.get("line_items", [])
            )
            log.info("Cart %s line item %s confirmed: %s", f["cart_id"], f["line_item_id"], confirmed)

    log.info("Done. %d stale line item(s) %s.", len(flagged), "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
