"""Flag and safely repair Medusa buyget promotions whose application_method
is structurally invalid, which makes computeActions silently return zero
adjustments on every cart update. Never rewrites a live promotion unless
DRY_RUN is explicitly false. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/buyget-promotion-not-applied-on-update/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_buyget_application_method")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PROMOTION_FIELDS = (
    "id,code,type,status,is_automatic,*application_method,"
    "*application_method.target_rules,*application_method.buy_rules"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_buyget_promotions(token):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/promotions",
        params={"fields": PROMOTION_FIELDS, "type": "buyget", "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotions"]


def is_buyget_application_method_valid(am):
    """Pure: no I/O. Takes an application_method dict and returns
    {"valid": bool, "reasons": [str, ...]}. Adds one reason for each of:
    target_rules empty, buy_rules empty, buy_rules_min_quantity missing or
    not positive, target_type == "order", allocation not in
    ["across", "each"], apply_to_quantity missing, or (allocation == "each"
    and max_quantity missing). valid is True only when reasons is empty.
    Mirrors the exact shape the buyget engine requires to ever produce
    a computeActions adjustment.
    """
    reasons = []
    if not (am.get("target_rules") or []):
        reasons.append("target_rules is empty")
    if not (am.get("buy_rules") or []):
        reasons.append("buy_rules is empty")
    min_qty = am.get("buy_rules_min_quantity")
    if min_qty is None or min_qty <= 0:
        reasons.append("buy_rules_min_quantity is missing or not positive")
    if am.get("target_type") == "order":
        reasons.append('target_type "order" is not supported for buyget')
    if am.get("allocation") not in ("across", "each"):
        reasons.append("allocation must be across or each")
    if am.get("apply_to_quantity") is None:
        reasons.append("apply_to_quantity is missing")
    if am.get("allocation") == "each" and am.get("max_quantity") is None:
        reasons.append("max_quantity is required when allocation is each")
    return {"valid": len(reasons) == 0, "reasons": reasons}


def build_corrected_application_method(am):
    """Pure: computes the corrected application_method payload for a
    flagged promotion. Keeps the existing buy_rules and target_rules
    (a human authored what should discount what), forces a supported
    target_type, and fills in the missing quantity fields.
    """
    allocation = am.get("allocation") if am.get("allocation") in ("across", "each") else "across"
    corrected = {
        "id": am.get("id"),
        "target_type": "items",
        "allocation": allocation,
        "apply_to_quantity": am.get("apply_to_quantity") or am.get("buy_rules_min_quantity") or 1,
        "target_rules": am.get("target_rules") or [],
        "buy_rules": am.get("buy_rules") or [],
    }
    if allocation == "each":
        corrected["max_quantity"] = am.get("max_quantity") or corrected["apply_to_quantity"]
    return corrected


def patch_application_method(token, promotion_id, corrected):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/promotions/{promotion_id}",
        json={"application_method": corrected},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotion"]


def find_open_carts_with_code(token, code):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(
        f"{BASE_URL}/admin/carts",
        params={"fields": "id,*promotions,*items,*items.adjustments", "limit": 100},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    carts = r.json().get("carts", [])
    affected = []
    for cart in carts:
        codes = [p.get("code") for p in (cart.get("promotions") or [])]
        if code not in codes:
            continue
        has_adjustment = any(
            (item.get("adjustments") or []) for item in (cart.get("items") or [])
        )
        affected.append({"cart_id": cart.get("id"), "has_adjustment": has_adjustment})
    return affected


def recompute_cart_promotions(token, cart_id, promo_codes):
    """Re-triggers Medusa's own updateCartPromotionsWorkflow by re-sending
    the same promo codes to the storefront cart promotions endpoint, so any
    resulting adjustment comes from Medusa's engine, never injected by hand.
    Requires a store publishable API key in practice; left as a thin helper
    so the write path stays out of run()'s core loop.
    """
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/store/carts/{cart_id}/promotions",
        json={"promo_codes": promo_codes},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def run():
    token = get_token()
    promotions = list_buyget_promotions(token)

    flagged = 0
    for promo in promotions:
        am = promo.get("application_method") or {}
        result = is_buyget_application_method_valid(am)
        if result["valid"]:
            continue

        flagged += 1
        corrected = build_corrected_application_method(am)
        affected_carts = find_open_carts_with_code(token, promo.get("code"))
        log.warning(
            "Promotion %s (%s) invalid: %s. %d open cart(s) reference this code.",
            promo.get("id"), promo.get("code"), "; ".join(result["reasons"]), len(affected_carts),
        )
        log.info(
            "%s application_method diff: before=%s after=%s",
            "Would apply" if DRY_RUN else "Applying", am, corrected,
        )

        if not DRY_RUN:
            patch_application_method(token, promo["id"], corrected)
            log.info("Patched promotion %s. Re-run cart promotions to verify adjustments.", promo["id"])

    log.info("Done. %d buyget promotion(s) %s.", flagged, "flagged" if DRY_RUN else "flagged and repaired")


if __name__ == "__main__":
    run()
