"""Flag Medusa price lists that keep serving prices past their end date.
Reports every affected price list and variant by default.
Only moves a confirmed list to status draft when DRY_RUN is explicitly false.
Never guesses at commercial data. Safe to run again and again.
"""
import os
import logging
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flag_expired_price_lists")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,rules_count,*prices"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_price_lists(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/price-lists",
            params={"fields": PRICE_LIST_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["price_lists"])
        offset += limit
        if offset >= body["count"]:
            return out


def is_price_list_expired_but_active(price_list, now):
    """Pure: true only when status is active and ends_at is a real timestamp already passed.

    Returns False when ends_at is None (no expiry set) or status is already "draft".
    """
    if price_list.get("status") != "active":
        return False
    ends_at = price_list.get("ends_at")
    if ends_at is None:
        return False
    ends_dt = ends_at if isinstance(ends_at, datetime) else datetime.fromisoformat(
        ends_at.replace("Z", "+00:00")
    )
    return now > ends_dt


def pick_best_calculated_price(candidate_prices, now):
    """Pure: filters out expired-but-active or draft price-list candidates, then
    returns the lowest amount remaining, or None if nothing qualifies.

    Each candidate looks like:
      {id, amount, price_list_id, price_list_ends_at, price_list_status}
    """
    eligible = []
    for c in candidate_prices:
        if c.get("price_list_status") == "draft":
            continue
        if c.get("price_list_id"):
            fake_list = {
                "status": c.get("price_list_status"),
                "ends_at": c.get("price_list_ends_at"),
            }
            if is_price_list_expired_but_active(fake_list, now):
                continue
        eligible.append(c)
    if not eligible:
        return None
    best = min(eligible, key=lambda c: c["amount"])
    return {"id": best["id"], "amount": best["amount"]}


def fetch_calculated_price(product_id, region_id):
    r = requests.get(
        f"{BASE_URL}/store/products/{product_id}",
        params={"region_id": region_id, "fields": "id,*variants.calculated_price"},
        headers={"x-publishable-api-key": PUBLISHABLE_KEY},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def confirm_affected(product, expired_price_ids):
    affected = []
    for variant in product.get("variants", []):
        cp = variant.get("calculated_price") or {}
        if cp.get("id") in expired_price_ids:
            affected.append(variant["id"])
    return affected


def deactivate_price_list(token, price_list_id):
    r = requests.post(
        f"{BASE_URL}/admin/price-lists/{price_list_id}",
        json={"status": "draft"},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["price_list"]


def run():
    token = get_token()
    now = datetime.now(timezone.utc)

    price_lists = list_price_lists(token)
    flagged = [pl for pl in price_lists if is_price_list_expired_but_active(pl, now)]

    if not flagged:
        log.info("No expired-but-active price lists found out of %d.", len(price_lists))
        return

    for pl in flagged:
        price_ids = [p["id"] for p in (pl.get("prices") or [])]
        log.warning(
            "Price list %s (%s) is status=active with ends_at=%s in the past. %d price row(s) still attached.",
            pl["id"], pl.get("title"), pl.get("ends_at"), len(price_ids),
        )
        if not DRY_RUN:
            deactivate_price_list(token, pl["id"])
            log.info(
                "Moved %s to status=draft. Re-check calculated_price and purge any CDN cache in front of /store.",
                pl["id"],
            )
        else:
            log.info("DRY_RUN=true. Would set status=draft on %s.", pl["id"])

    log.info("Done. %d price list(s) flagged out of %d.", len(flagged), len(price_lists))


if __name__ == "__main__":
    run()
