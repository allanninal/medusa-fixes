"""Audit a Medusa promotion for why it is not applying to a cart.
Diffs the promotion's rules, target_rules, and buy_rules against a real cart's
context and reports the first mismatched rule, never mutates the promotion.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/promotion-not-applying-rules-mismatch/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("audit_promotion_rules")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PROMOTION_FIELDS = (
    "id,code,is_automatic,status,*rules,*application_method,"
    "*application_method.target_rules,*application_method.buy_rules,*campaign"
)
CART_FIELDS = "id,currency_code,region_id,customer_id,*items,*items.product_id"


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_promotion(token, promotion_id):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/promotions/{promotion_id}",
        params={"fields": PROMOTION_FIELDS},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotion"]


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


def get_customer_groups(token, customer_id):
    if not customer_id:
        return []
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/customers/{customer_id}",
        params={"fields": "id,*groups"},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    groups = r.json()["customer"].get("groups") or []
    return [g["id"] for g in groups]


def build_cart_context(cart, customer_group_ids):
    return {
        "currency_code": cart.get("currency_code"),
        "region": {"id": cart.get("region_id")},
        "region_id": cart.get("region_id"),
        "customer": {"groups": [{"id": gid} for gid in customer_group_ids]},
        "items": {"product": {"id": [item.get("product_id") for item in (cart.get("items") or [])]}},
    }


def _resolve_path(attribute, cart_context):
    node = cart_context
    for part in attribute.split("."):
        if isinstance(node, list):
            node = [item.get(part) if isinstance(item, dict) else None for item in node]
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            return None
    return node


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        out = []
        for v in value:
            out.extend(_as_list(v)) if isinstance(v, list) else out.append(v)
        return out
    return [value]


def rule_matches_cart(rule, cart_context):
    """Pure: resolves rule.attribute as a dot-path into cart_context and applies
    rule.operator against rule.values. Returns False (never throws) on any
    unresolved path, empty values, or incompatible types, mirroring Medusa's
    real fail-closed rule evaluation.
    """
    attribute = rule.get("attribute")
    operator = rule.get("operator")
    values = rule.get("values") or []
    if not attribute or not operator or not values:
        return False

    resolved = _as_list(_resolve_path(attribute, cart_context))
    if not resolved:
        return False

    if operator in ("eq", "in"):
        return any(v in values for v in resolved)
    if operator == "ne":
        return not any(v in values for v in resolved)
    if operator in ("gt", "gte", "lt", "lte"):
        if len(resolved) != 1:
            return False
        try:
            left, right = float(resolved[0]), float(values[0])
        except (TypeError, ValueError):
            return False
        if operator == "gt":
            return left > right
        if operator == "gte":
            return left >= right
        if operator == "lt":
            return left < right
        return left <= right
    return False


def build_fix_payload(rule):
    if rule.get("operator") == "eq" and len(_as_list(rule.get("values"))) > 0:
        return {"id": rule.get("id"), "operator": "in", "values": rule.get("values")}
    return {"id": rule.get("id"), "attribute": rule.get("attribute"), "values": rule.get("values")}


def audit_promotion(promotion, cart_context):
    """Pure: returns a list of report dicts, one per rule that fails to match."""
    reports = []

    if promotion.get("status") != "active":
        reports.append({
            "promotion_id": promotion["id"],
            "reason": f"status is {promotion.get('status')!r}, not active",
            "rule_id": None,
            "fix": {"status": "active"},
        })

    for rule in promotion.get("rules") or []:
        if not rule_matches_cart(rule, cart_context):
            reports.append({
                "promotion_id": promotion["id"],
                "reason": f"eligibility rule {rule.get('attribute')} {rule.get('operator')} does not match the cart",
                "rule_id": rule.get("id"),
                "fix": build_fix_payload(rule),
            })

    method = promotion.get("application_method") or {}
    for rule in method.get("target_rules") or []:
        if not rule_matches_cart(rule, cart_context):
            reports.append({
                "promotion_id": promotion["id"],
                "reason": f"target rule {rule.get('attribute')} {rule.get('operator')} does not match any cart item",
                "rule_id": rule.get("id"),
                "fix": build_fix_payload(rule),
            })
    for rule in method.get("buy_rules") or []:
        if not rule_matches_cart(rule, cart_context):
            reports.append({
                "promotion_id": promotion["id"],
                "reason": f"buy rule {rule.get('attribute')} {rule.get('operator')} does not match any cart item",
                "rule_id": rule.get("id"),
                "fix": build_fix_payload(rule),
            })

    return reports


def run(promotion_id, cart_id):
    token = get_token()
    promotion = get_promotion(token, promotion_id)
    cart = get_cart(token, cart_id)
    customer_group_ids = get_customer_groups(token, cart.get("customer_id"))
    cart_context = build_cart_context(cart, customer_group_ids)

    reports = audit_promotion(promotion, cart_context)
    if not reports:
        log.info("Promotion %s matches this cart on every rule.", promotion_id)
        return

    for r in reports:
        log.info(
            "Promotion %s: %s. %s payload: %s",
            r["promotion_id"], r["reason"],
            "Would send" if DRY_RUN else "Suggested",
            r["fix"],
        )
    log.info("Done. %d rule(s) flagged for promotion %s.", len(reports), promotion_id)


if __name__ == "__main__":
    run(os.environ["PROMOTION_ID"], os.environ["CART_ID"])
