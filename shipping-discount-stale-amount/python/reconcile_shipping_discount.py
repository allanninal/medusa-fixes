"""Flag Medusa v2 carts whose shipping promotion adjustment was computed against
a stale shipping amount, and safely repair by re-applying the same promotion
codes so Medusa's own updateCartPromotionsWorkflow recomputes it for real.
Never writes ShippingMethodAdjustment.amount directly. DRY_RUN=true only logs
stored vs expected. Safe to run again and again, one cart at a time.

Guide: https://www.allanninal.dev/medusa/shipping-discount-stale-amount/
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_shipping_discount")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

TOLERANCE = 0.01

CART_FIELDS = (
    "id,shipping_total,item_total,"
    "*shipping_methods,*shipping_methods.adjustments,*promotions"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_cart(token, cart_id):
    r = requests.get(
        f"{BASE_URL}/store/carts/{cart_id}",
        params={"fields": CART_FIELDS},
        headers={
            "Authorization": f"Bearer {token}",
            "x-publishable-api-key": PUBLISHABLE_KEY,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def get_promotion(token, promotion_id):
    r = requests.get(
        f"{BASE_URL}/admin/promotions/{promotion_id}",
        params={"fields": "id,code,application_method.value,application_method.target_type,application_method.type"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["promotion"]


def compute_expected_shipping_adjustment(shipping_method, promotion):
    """Pure: no I/O. shipping_method is {"id","amount"}.
    promotion is {"id","code","application_method": {"type","value","target_type"}}.
    Returns None when the promotion does not target shipping methods."""
    app = promotion["application_method"]
    if app["target_type"] != "shipping_methods":
        return None
    amount = shipping_method["amount"]
    if app["type"] == "percentage":
        adjustment_amount = amount * (app["value"] / 100)
    else:
        adjustment_amount = min(app["value"], amount)
    return {"adjustment_amount": adjustment_amount, "is_stale": False, "delta": 0}


def evaluate_stale_adjustment(shipping_method, promotion, stored_amount):
    """Pure: no I/O. Combines the expected amount with the persisted stored_amount
    (read by the caller) to produce delta and is_stale."""
    expected = compute_expected_shipping_adjustment(shipping_method, promotion)
    if expected is None:
        return None
    delta = stored_amount - expected["adjustment_amount"]
    expected["delta"] = delta
    expected["is_stale"] = abs(delta) > TOLERANCE
    return expected


def reapply_promotions(token, cart_id, promo_codes):
    r = requests.post(
        f"{BASE_URL}/store/carts/{cart_id}/promotions",
        json={"promo_codes": promo_codes},
        headers={
            "Authorization": f"Bearer {token}",
            "x-publishable-api-key": PUBLISHABLE_KEY,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["cart"]


def find_stale_shipping_adjustments(token, cart_id):
    cart = get_cart(token, cart_id)
    promotions_by_code = {p["code"]: p for p in cart.get("promotions", [])}
    flagged = []
    for method in cart.get("shipping_methods", []):
        shipping_method = {"id": method["id"], "amount": method["amount"]}
        for adj in method.get("adjustments", []) or []:
            code = adj.get("code")
            promo = promotions_by_code.get(code)
            if promo is None:
                continue
            promotion = get_promotion(token, promo["id"])
            result = evaluate_stale_adjustment(shipping_method, promotion, adj["amount"])
            if result is None or not result["is_stale"]:
                continue
            flagged.append({
                "cart_id": cart_id,
                "shipping_method_id": method["id"],
                "promotion_code": code,
                "stored_amount": adj["amount"],
                "expected_amount": result["adjustment_amount"],
                "delta": result["delta"],
            })
    return flagged, list(promotions_by_code.keys())


def run(cart_ids=None):
    token = get_token()
    cart_ids = cart_ids or os.environ.get("CART_IDS", "").split(",")
    cart_ids = [c.strip() for c in cart_ids if c.strip()]

    total_flagged = 0
    for cart_id in cart_ids:
        flagged, codes = find_stale_shipping_adjustments(token, cart_id)
        for f in flagged:
            log.info(
                "Cart %s shipping method %s promo %s: stored=%s expected=%s delta=%s. %s",
                f["cart_id"], f["shipping_method_id"], f["promotion_code"],
                f["stored_amount"], f["expected_amount"], f["delta"],
                "Would re-apply" if DRY_RUN else "Re-applying",
            )
            if not DRY_RUN:
                reapply_promotions(token, cart_id, codes)
            total_flagged += 1

    log.info("Done. %d stale shipping adjustment(s) %s.", total_flagged, "to repair" if DRY_RUN else "repaired")


if __name__ == "__main__":
    run()
