"""Find Medusa v2 variants where an active price list is wrongly suppressing
the default variant price.

Medusa's pricing module resolves calculated_price by first checking whether
any price list price matches the given context. Once a matching price list
price set exists at all, the price-selection strategy never falls back to
compare against the variant's default price, even when the price list rules
do not match the current shopper or the default is actually cheaper. This is
a known core bug (medusajs/medusa#10613). This script only reports affected
variants. It never edits or deactivates a price list on its own.

Guide: https://www.allanninal.dev/medusa/price-list-suppresses-default-price/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_suppressed_default_price")

BASE = os.environ["MEDUSA_BACKEND_URL"]
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
REGION_ID = os.environ.get("MEDUSA_REGION_ID", "")
CURRENCY_CODE = os.environ.get("MEDUSA_CURRENCY_CODE", "usd")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRICE_LIST_FIELDS = "id,title,status,rules,starts_at,ends_at,prices.amount,prices.currency_code,prices.price_list_id"
PRODUCT_FIELDS = "id,*variants,variants.prices.amount,variants.prices.currency_code,variants.prices.price_list_id"


def rules_match(price_list_rules, request_context):
    """Pure. price_list_rules is a plain dict of rule_key -> [allowed values].
    request_context carries customer_group_ids among other fields."""
    for rule_key, allowed_values in (price_list_rules or {}).items():
        if rule_key == "customer_group_id":
            requested = set(request_context.get("customer_group_ids") or [])
            if not requested.intersection(allowed_values):
                return False
    return True


def is_default_price_wrongly_suppressed(
    calculated_amount,
    is_calculated_price_from_price_list,
    price_list_rules,
    request_context,
    default_amount_for_currency,
):
    """Pure decision logic. No I/O. Returns {"suppressed": bool, "reason": str}.

    - Not from a price list at all: never suppressed.
    - No default price to compare against: nothing to fall back to, so not
      flagged (there is no wrong answer to compare with).
    - Price list rules do not intersect the request context (for example the
      requesting customer is not in the price list's customer group), yet
      the price list price was still used: flagged as "rules_mismatch".
    - Otherwise, if the price list amount is higher than the default amount,
      the fallback to the cheaper default should have won: flagged as
      "higher_than_default".
    """
    if not is_calculated_price_from_price_list:
        return {"suppressed": False, "reason": "none"}

    if default_amount_for_currency is None:
        return {"suppressed": False, "reason": "none"}

    if not rules_match(price_list_rules, request_context):
        return {"suppressed": True, "reason": "rules_mismatch"}

    if calculated_amount > default_amount_for_currency:
        return {"suppressed": True, "reason": "higher_than_default"}

    return {"suppressed": False, "reason": "none"}


def login():
    r = requests.post(
        f"{BASE}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def active_price_lists(token):
    offset, out = 0, []
    while True:
        r = requests.get(
            f"{BASE}/admin/price-lists",
            params={"status[]": "active", "fields": PRICE_LIST_FIELDS, "offset": offset, "limit": 50},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["price_lists"])
        offset += body["limit"]
        if offset >= body["count"]:
            return out


def price_list_products(token, price_list_id):
    r = requests.get(
        f"{BASE}/admin/price-lists/{price_list_id}/products",
        params={"fields": PRODUCT_FIELDS},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["products"]


def calculated_price_for_product(token, product_id, region_id, currency_code):
    r = requests.get(
        f"{BASE}/admin/products/{product_id}",
        params={"fields": "id,*variants.calculated_price", "region_id": region_id, "currency_code": currency_code},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]["variants"]


def default_amount_for_currency(variant, currency_code):
    for price in variant.get("prices") or []:
        if price.get("currency_code") == currency_code and not price.get("price_list_id"):
            return price["amount"]
    return None


def report_line(price_list_id, variant_id, currency_code, decision, calculated_amount, default_amount):
    return (
        f"price_list={price_list_id} variant={variant_id} currency={currency_code} "
        f"reason={decision['reason']} calculated={calculated_amount} default={default_amount}"
    )


def run():
    token = login()
    request_context = {"region_id": REGION_ID, "currency_code": CURRENCY_CODE, "customer_group_ids": []}
    flagged = 0

    for price_list in active_price_lists(token):
        rules = price_list.get("rules") or {}
        for product in price_list_products(token, price_list["id"]):
            calc_variants = {
                v["id"]: v for v in calculated_price_for_product(token, product["id"], REGION_ID, CURRENCY_CODE)
            }

            for variant in product.get("variants") or []:
                calc = calc_variants.get(variant["id"], {}).get("calculated_price") or {}
                default_amount = default_amount_for_currency(variant, CURRENCY_CODE)

                decision = is_default_price_wrongly_suppressed(
                    calculated_amount=calc.get("calculated_amount"),
                    is_calculated_price_from_price_list=bool(calc.get("is_calculated_price_price_list")),
                    price_list_rules=rules,
                    request_context=request_context,
                    default_amount_for_currency=default_amount,
                )

                if not decision["suppressed"]:
                    continue

                log.warning(
                    report_line(
                        price_list["id"], variant["id"], CURRENCY_CODE, decision, calc.get("calculated_amount"), default_amount
                    )
                )
                flagged += 1

    log.info("Done. %d variant/price list combination(s) flagged for review. Dry run: %s", flagged, DRY_RUN)


if __name__ == "__main__":
    run()
