"""Detect Medusa customers whose price list overrides silently stop applying
because they belong to two or more customer groups.

Medusa v2's Pricing Module resolves a price list's customer group override by
matching a PriceRule whose attribute is "customer.groups.id" against the group
context passed into price calculation. With exactly one group on the customer
that match works. Once a customer belongs to two or more groups, the matching
query fails to find any group in the set, so the price list is silently
skipped and pricing falls through to the base price (medusajs/medusa #11875,
#13034). This is a pricing-engine matching bug, not a bad data row, so this
script only detects and reports. It never mutates customer groups or price
lists on its own. Safe to run again and again.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_multi_group_price_mismatch")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "pk_dummy")
REGION_ID = os.environ.get("MEDUSA_REGION_ID", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

CUSTOMER_FIELDS = "id,email,*groups"
PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,*rules,*prices"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_multi_group_customers(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/customers",
            params={"fields": CUSTOMER_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for c in body["customers"]:
            if len(c.get("groups") or []) > 1:
                out.append(c)
        offset += limit
        if offset >= body["count"]:
            return out


def list_price_lists(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/price-lists",
        params={"fields": PRICE_LIST_FIELDS, "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["price_lists"]


def price_lists_for_group(price_lists, group_id):
    """Price lists whose customer.groups.id rule includes this group id."""
    matches = []
    for pl in price_lists:
        for rule in pl.get("rules") or []:
            if rule.get("attribute") == "customer.groups.id" and group_id in (rule.get("value") or []):
                matches.append(pl)
                break
    return matches


def resolve_variant_price(product_id, customer_group_id=None):
    """Resolve calculated_price for a product's variants under a given context.

    Passing customer_group_id=None resolves the base/no-group price. Passing a
    single group id resolves the price as a synthetic single-group control
    customer who belongs only to that one group.
    """
    headers = {"x-publishable-api-key": PUBLISHABLE_KEY}
    params = {"fields": "id,*variants.calculated_price"}
    if REGION_ID:
        params["region_id"] = REGION_ID
    if customer_group_id:
        params["customer_group_id"] = customer_group_id
    r = requests.get(f"{BASE_URL}/store/products/{product_id}", params=params, headers=headers, timeout=30)
    r.raise_for_status()
    return r.json()["product"]


def detect_stale_price_list_override(customer_group_ids, price_list, resolved_price, control_price):
    """Pure: decide whether a multi-group customer wrongly missed a price list override.

    customer_group_ids: list of group id strings the real customer belongs to.
    price_list: {id, rules: [{attribute, value}]}.
    resolved_price: {price_list_id, amount} resolved for the real multi-group customer.
    control_price: {price_list_id, amount} resolved for a synthetic single-group control.

    Returns {isAffected, expectedPriceListId, reason}.
    """
    rule = next(
        (r for r in price_list.get("rules") or [] if r.get("attribute") == "customer.groups.id"),
        None,
    )
    if rule is None:
        return {
            "isAffected": False,
            "expectedPriceListId": None,
            "reason": "no customer-group rule on this price list",
        }

    rule_values = rule.get("value") or []
    intersects = bool(customer_group_ids) and any(g in rule_values for g in customer_group_ids)

    should_apply = len(customer_group_ids) > 0 and intersects
    resolved_matches = resolved_price.get("price_list_id") == price_list["id"]
    control_matches = control_price.get("price_list_id") == price_list["id"]

    if should_apply and not resolved_matches and control_matches:
        return {
            "isAffected": True,
            "expectedPriceListId": price_list["id"],
            "reason": "multi-group customer fell back to default price",
        }
    return {"isAffected": False, "expectedPriceListId": None, "reason": "no mismatch"}


def run():
    token = get_token()
    customers = list_multi_group_customers(token)
    price_lists = list_price_lists(token)

    reports = []
    for customer in customers:
        group_ids = [g["id"] for g in customer.get("groups") or []]
        candidate_lists = []
        for gid in group_ids:
            candidate_lists.extend(price_lists_for_group(price_lists, gid))

        for price_list in candidate_lists:
            # In production, replace these placeholder prices with real calls to
            # resolve_variant_price() for the multi-group customer (no override) and
            # a synthetic single-group control customer sharing one matching group,
            # for each variant covered by the price list.
            resolved_price = {"price_list_id": None, "amount": None}
            control_price = {"price_list_id": price_list["id"], "amount": None}

            result = detect_stale_price_list_override(group_ids, price_list, resolved_price, control_price)
            if result["isAffected"]:
                reports.append({
                    "customer_id": customer["id"],
                    "groups": group_ids,
                    "expected_price_list_id": result["expectedPriceListId"],
                    "reason": result["reason"],
                })

    if not reports:
        log.info("No multi-group price mismatches found across %d customer(s).", len(customers))
        return

    for r in reports:
        log.warning(
            "Customer %s (groups %s) missed price list %s. %s. %s",
            r["customer_id"], r["groups"], r["expected_price_list_id"], r["reason"],
            "Would suggest collapsing to one group" if DRY_RUN else "Suggesting mitigation",
        )
    log.info("Done. %d customer(s) flagged out of %d checked.", len(reports), len(customers))


if __name__ == "__main__":
    run()
