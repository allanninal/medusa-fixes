"""Audit Medusa price lists for why they are not applied at checkout.
Reports mismatches (draft, scheduled, expired, or missing currency/region price).
Never mutates merchant pricing data. Safe to run again and again.
"""
import os
import logging
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_price_lists")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,type,*prices,*prices.price_rules,*rules"


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
    out, offset, limit = [], 0, 100
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


def list_regions(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/regions",
        params={"fields": "id,name,currency_code", "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["regions"]


def get_price_list_effective_state(price_list, now):
    # Draft always wins regardless of dates, a draft list is never live.
    if price_list.get("status") == "draft":
        return "draft"

    starts_at = price_list.get("starts_at")
    ends_at = price_list.get("ends_at")
    starts_dt = datetime.fromisoformat(starts_at.replace("Z", "+00:00")) if starts_at else None
    ends_dt = datetime.fromisoformat(ends_at.replace("Z", "+00:00")) if ends_at else None

    if starts_dt and now < starts_dt:
        return "scheduled"  # not started yet, full price still shown
    if ends_dt and now > ends_dt:
        return "expired"    # window closed, full price still shown
    return "active"          # status is active AND now falls within the window


def has_matching_price(prices, context):
    for p in prices or []:
        if p.get("currency_code") != context.get("currency_code"):
            continue
        rules = p.get("rules") or {}
        if rules.get("region_id") and rules["region_id"] != context.get("region_id"):
            continue
        if rules.get("customer_group_id") and rules["customer_group_id"] != context.get("customer_group_id"):
            continue
        return True
    return False


def build_fix_payload(price_list, state):
    if state == "draft":
        return {"status": "active"}
    if state == "scheduled":
        return {"starts_at": datetime.now(timezone.utc).isoformat()}
    if state == "expired":
        return {"ends_at": None}
    return None


def audit(price_lists, regions, now):
    """Pure: returns a list of report dicts, one per mismatched price list."""
    reports = []
    for pl in price_lists:
        state = get_price_list_effective_state(pl, now)
        if state != "active":
            reports.append({
                "price_list_id": pl["id"],
                "title": pl.get("title"),
                "reason": state,
                "fix": build_fix_payload(pl, state),
            })
            continue
        for region in regions:
            context = {"currency_code": region["currency_code"], "region_id": region["id"]}
            if not has_matching_price(pl.get("prices"), context):
                reports.append({
                    "price_list_id": pl["id"],
                    "title": pl.get("title"),
                    "reason": "active-but-no-matching-currency/region-price",
                    "region": region["name"],
                    "currency_code": region["currency_code"],
                    "fix": {"currency_code": region["currency_code"], "rules": {"region_id": region["id"]}},
                })
    return reports


def run():
    token = get_token()
    price_lists = list_price_lists(token)
    regions = list_regions(token)
    now = datetime.now(timezone.utc)

    reports = audit(price_lists, regions, now)
    if not reports:
        log.info("All %d price list(s) are effectively active with full currency coverage.", len(price_lists))
        return

    for r in reports:
        log.info(
            "Price list %s (%s): %s. %s payload: %s",
            r["price_list_id"], r["title"], r["reason"],
            "Would send" if DRY_RUN else "Suggested",
            r["fix"],
        )
    log.info("Done. %d price list(s) flagged out of %d.", len(reports), len(price_lists))


if __name__ == "__main__":
    run()
