"""Flag Medusa contexts where tax-inclusive pricing settings disagree.

Whether a price is tax-inclusive is not one global flag in Medusa v2. It is
decided per calculation context by a PricePreference keyed on region_id or
currency_code, and the same includes_tax concept is set again independently on
Region, Currency, PriceList, and ShippingOption. Because those settings are
configured in different admin screens, they can drift out of sync, so
calculatePrices resolves is_calculated_price_tax_inclusive inconsistently
across line items and the cart totals engine stops reconciling: subtotal plus
tax_total no longer equals total. This never rewrites an order's totals or a
price amount. It only ever writes the specific PricePreference a human has
approved. Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/tax-inclusive-pricing-shows-wrong-totals/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_tax_inclusivity_mismatches")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
ROUNDING_TOLERANCE = 0.02

# Optional, human-approved fix for exactly one context.
# Format: "region_id|currency_code:value:true|false"
# Example: "region_id:reg_01ABC:true"
APPLY_FIX_FOR = None
_raw_fix = os.environ.get("APPLY_FIX_FOR", "").strip()
if _raw_fix:
    _attribute, _value, _flag = _raw_fix.split(":")
    APPLY_FIX_FOR = {"attribute": _attribute, "value": _value, "is_tax_inclusive": _flag.lower() == "true"}


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


def admin_post(token, path, body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def find_tax_inclusivity_mismatches(preferences, price_contexts):
    """Pure decision function. No I/O.

    preferences: [{"attribute": "region_id" | "currency_code", "value": str,
                   "is_tax_inclusive": bool}, ...]
    price_contexts: [{"source_type": "price_list" | "shipping_option", "source_id": str,
                       "region_id": str | None, "currency_code": str | None}, ...]

    Returns a list of mismatches: {source_type, source_id, region_id, currency_code,
    region_pref, currency_pref, reason}.
    """
    region_pref_map = {}
    currency_pref_map = {}
    for pref in preferences:
        if pref["attribute"] == "region_id":
            region_pref_map[pref["value"]] = pref["is_tax_inclusive"]
        elif pref["attribute"] == "currency_code":
            currency_pref_map[pref["value"]] = pref["is_tax_inclusive"]

    mismatches = []
    for ctx in price_contexts:
        region_pref = region_pref_map.get(ctx.get("region_id"))
        currency_pref = currency_pref_map.get(ctx.get("currency_code"))

        if region_pref is not None and currency_pref is not None and region_pref != currency_pref:
            reason = "region/currency preference conflict"
        elif region_pref is None and currency_pref is None:
            reason = "no preference configured, defaults may drift"
        else:
            continue

        mismatches.append({
            "source_type": ctx["source_type"],
            "source_id": ctx["source_id"],
            "region_id": ctx.get("region_id"),
            "currency_code": ctx.get("currency_code"),
            "region_pref": region_pref,
            "currency_pref": currency_pref,
            "reason": reason,
        })
    return mismatches


def list_regions(token):
    regions = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/regions", {
            "fields": "id,name,currency_code,automatic_taxes",
            "limit": limit,
            "offset": offset,
        })
        regions.extend(data["regions"])
        offset += limit
        if offset >= data["count"]:
            return regions


def list_price_preferences(token):
    preferences = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/price-preferences", {
            "fields": "id,attribute,value,is_tax_inclusive",
            "limit": limit,
            "offset": offset,
        })
        preferences.extend(data["price_preferences"])
        offset += limit
        if offset >= data["count"]:
            return preferences


def _rule_value(price, key):
    for rule in price.get("price_rules") or []:
        if rule.get("attribute") == key:
            return rule.get("value")
    return price.get(key)


def price_lists_as_contexts(token):
    data = admin_get(token, "/admin/price-lists", {
        "fields": "id,title,status,*prices",
        "limit": 100,
    })
    contexts = []
    for price_list in data["price_lists"]:
        for price in price_list.get("prices") or []:
            contexts.append({
                "source_type": "price_list",
                "source_id": price_list["id"],
                "region_id": _rule_value(price, "region_id"),
                "currency_code": price.get("currency_code"),
            })
    return contexts


def shipping_options_as_contexts(token):
    data = admin_get(token, "/admin/shipping-options", {
        "fields": "id,name,*prices,*prices.price_rules",
        "limit": 100,
    })
    contexts = []
    for option in data["shipping_options"]:
        for price in option.get("prices") or []:
            contexts.append({
                "source_type": "shipping_option",
                "source_id": option["id"],
                "region_id": _rule_value(price, "region_id"),
                "currency_code": price.get("currency_code"),
            })
    return contexts


def orders_with_bad_totals(token):
    data = admin_get(token, "/admin/orders", {
        "fields": "id,region_id,currency_code,subtotal,tax_total,shipping_total,total",
        "limit": 100,
    })
    bad = []
    for order in data["orders"]:
        expected = (order.get("subtotal") or 0) + (order.get("tax_total") or 0) + (order.get("shipping_total") or 0)
        if abs(expected - (order.get("total") or 0)) > ROUNDING_TOLERANCE:
            bad.append(order)
    return bad


def upsert_price_preference(token, attribute, value, is_tax_inclusive):
    return admin_post(token, "/admin/price-preferences", {
        "attribute": attribute,
        "value": value,
        "is_tax_inclusive": is_tax_inclusive,
    })


def run():
    token = get_admin_token()
    preferences = list_price_preferences(token)

    price_contexts = price_lists_as_contexts(token) + shipping_options_as_contexts(token)
    mismatches = find_tax_inclusivity_mismatches(preferences, price_contexts)

    for mismatch in mismatches:
        log.warning(
            "%s %s: region=%s currency=%s region_pref=%s currency_pref=%s reason=%s",
            mismatch["source_type"], mismatch["source_id"],
            mismatch["region_id"], mismatch["currency_code"],
            mismatch["region_pref"], mismatch["currency_pref"], mismatch["reason"],
        )

    bad_orders = orders_with_bad_totals(token)
    for order in bad_orders:
        log.warning(
            "Order %s totals do not reconcile: subtotal=%s tax_total=%s shipping_total=%s total=%s",
            order["id"], order.get("subtotal"), order.get("tax_total"),
            order.get("shipping_total"), order.get("total"),
        )

    applied = 0
    if APPLY_FIX_FOR is not None:
        log.info(
            "%s POST /admin/price-preferences %s",
            "Would call" if DRY_RUN else "Calling", APPLY_FIX_FOR,
        )
        if not DRY_RUN:
            upsert_price_preference(
                token, APPLY_FIX_FOR["attribute"], APPLY_FIX_FOR["value"], APPLY_FIX_FOR["is_tax_inclusive"],
            )
        applied = 1

    log.info(
        "Done. %d mismatch(es) flagged, %d order(s) with bad totals, %d preference write %s.",
        len(mismatches), len(bad_orders), applied, "to apply" if DRY_RUN else "applied",
    )


if __name__ == "__main__":
    run()
