"""Find Medusa orders where a sales-channel scoped promotion applied outside its channel.
Cross-checks every promotion's sales_channel_id rule against the orders it actually
touched and reports confirmed leaks. Never mutates a promotion or an order.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/promotion-ignores-channel-condition/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_channel_leaks")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ORDER_LIMIT = int(os.environ.get("ORDER_LIMIT", "100"))

PROMOTION_FIELDS = "id,code,status,*application_method,*rules"
ORDER_FIELDS = "id,sales_channel_id,promotions.id,promotions.code,promotions.rules,total,currency_code"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_promotions(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/promotions",
        params={"fields": PROMOTION_FIELDS, "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotions"]


def list_sales_channels(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/sales-channels",
        params={"fields": "id,name", "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return {sc["id"]: sc["name"] for sc in r.json()["sales_channels"]}


def list_orders(token, limit=ORDER_LIMIT):
    headers = {"Authorization": f"Bearer {token}"}
    offset = 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/orders",
            params={"fields": ORDER_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        orders = body["orders"]
        if not orders:
            return
        for order in orders:
            yield order
        offset += limit
        if offset >= body["count"]:
            return


def channel_rules(promotion):
    return [r for r in (promotion.get("rules") or []) if r.get("attribute") == "sales_channel_id"]


def is_promotion_allowed_for_channel(rules, cart_sales_channel_id):
    """Pure: returns True when a promotion's sales_channel_id rules (if any) are
    satisfied by cart_sales_channel_id. No channel rules means no restriction.
    Unknown operators and a missing channel id fail closed (return False),
    mirroring how a channel condition is supposed to be enforced.
    """
    channel_rules_ = [r for r in rules if r.get("attribute") == "sales_channel_id"]
    if not channel_rules_:
        return True

    for r in channel_rules_:
        if cart_sales_channel_id is None:
            return False
        is_member = cart_sales_channel_id in (r.get("values") or [])
        operator = r.get("operator")
        if operator in ("eq", "in"):
            if not is_member:
                return False
        elif operator in ("ne", "nin"):
            if is_member:
                return False
        else:
            return False
    return True


def find_leaks(promotions, orders, channel_names):
    """Pure: returns a list of leak reports, one per (order, promotion) pair where
    the promotion has a sales_channel_id rule and the order's channel violates it.
    """
    promo_by_id = {p["id"]: p for p in promotions}
    leaks = []
    for order in orders:
        order_channel = order.get("sales_channel_id")
        for applied in order.get("promotions") or []:
            promotion = promo_by_id.get(applied["id"], applied)
            rules = promotion.get("rules") or applied.get("rules") or []
            if not channel_rules(promotion) and not channel_rules(applied):
                continue
            if is_promotion_allowed_for_channel(rules, order_channel):
                continue
            allowed_ids = sorted({v for r in channel_rules(promotion) or channel_rules(applied) for v in (r.get("values") or [])})
            leaks.append({
                "promotion_id": promotion.get("id"),
                "code": promotion.get("code"),
                "expected_sales_channel_ids": allowed_ids,
                "order_id": order.get("id"),
                "actual_sales_channel_id": order_channel,
                "actual_sales_channel_name": channel_names.get(order_channel, order_channel),
                "order_total": order.get("total"),
                "currency_code": order.get("currency_code"),
            })
    return leaks


def run():
    token = get_token()
    promotions = [p for p in list_promotions(token) if channel_rules(p)]
    channel_names = list_sales_channels(token)
    orders = list(list_orders(token))

    leaks = find_leaks(promotions, orders, channel_names)
    if not leaks:
        log.info("No sales-channel leaks found across %d order(s).", len(orders))
        return

    for leak in leaks:
        log.warning(
            "Promotion %s (%s) applied on order %s in channel %s, expected one of %s. Total %s %s. %s",
            leak["promotion_id"], leak["code"], leak["order_id"],
            leak["actual_sales_channel_name"], leak["expected_sales_channel_ids"],
            leak["order_total"], leak["currency_code"],
            "Would flag." if DRY_RUN else "Flagged.",
        )
    log.info("Done. %d confirmed leak(s) found. Report only, nothing was changed.", len(leaks))


if __name__ == "__main__":
    run()
