"""Find Medusa v2 variants where a region scoped price is being ignored in
favor of a plain currency only price.

The Pricing Module's calculated_price resolver first looks for a price whose
rule set is an exact, complete match for the request context. When nothing
matches every rule at once it falls back to the price matching the most
rules, and ties or partial matches resolve toward the plain currency only
row instead of the region scoped one (medusajs/medusa#13120). The data is
stored correctly, so this script only reports. It never rewrites a price.

Guide: https://www.allanninal.dev/medusa/region-price-ignored/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_ignored_region_price")

BASE = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCT_FIELDS = (
    "id,title,*variants,"
    "variants.prices.id,variants.prices.amount,variants.prices.currency_code,"
    "variants.prices.rules_count,"
    "variants.prices.price_rules.attribute,variants.prices.price_rules.value"
)


def _rule_satisfied(rule, context):
    if rule["attribute"] == "region_id":
        return rule["value"] == context.get("region_id")
    if rule["attribute"] == "currency_code":
        return rule["value"] == context.get("currency_code")
    return False


def pick_winning_price(prices, context):
    """Pure decision logic. No I/O.

    prices: list of {id, amount, currency_code, rules: [{attribute, value}]}
    context: {region_id, currency_code}
    Returns {"id": ..., "amount": ...} or None if nothing matches.

    Decision: (1) filter to prices whose every rule is satisfied by context
    and whose currency_code matches context; (2) among survivors, rank by
    number of matched rules, then by total rule count (more specific wins
    ties), then prefer rows that explicitly carry a region_id rule; (3)
    return the top candidate or None. This is the exact branch to reproduce
    issue #13120 against: a region+currency price must outrank a
    currency-only price for the same currency_code and matching region_id.
    """
    candidates = [
        p for p in prices
        if p["currency_code"] == context.get("currency_code")
        and all(_rule_satisfied(r, context) for r in p.get("rules") or [])
    ]
    if not candidates:
        return None

    def sort_key(p):
        rules = p.get("rules") or []
        matched = sum(1 for r in rules if _rule_satisfied(r, context))
        has_region_rule = any(r["attribute"] == "region_id" for r in rules)
        return (matched, len(rules), 1 if has_region_rule else 0)

    winner = max(candidates, key=sort_key)
    return {"id": winner["id"], "amount": winner["amount"]}


def login():
    r = requests.post(
        f"{BASE}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_regions(token):
    r = requests.get(
        f"{BASE}/admin/regions",
        params={"fields": "id,name,currency_code,countries.iso_2"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["regions"]


def iter_products(token):
    offset = 0
    while True:
        r = requests.get(
            f"{BASE}/admin/products",
            params={"fields": PRODUCT_FIELDS, "offset": offset, "limit": 50},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            yield product
        offset += body["limit"]
        if offset >= body["count"]:
            return


def served_calculated_price(publishable_key, product_id, region_id):
    r = requests.get(
        f"{BASE}/store/products/{product_id}",
        params={"region_id": region_id, "fields": "*variants.calculated_price"},
        headers={"x-publishable-api-key": publishable_key},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]["variants"]


def variant_price_dicts(variant):
    out = []
    for price in variant.get("prices") or []:
        rules = [
            {"attribute": rule["attribute"], "value": rule["value"]}
            for rule in price.get("price_rules") or []
        ]
        out.append({
            "id": price["id"],
            "amount": price["amount"],
            "currency_code": price["currency_code"],
            "rules": rules,
        })
    return out


def has_region_and_currency_only_pair(prices, region_id, currency_code):
    """Pure. True when the variant has both a region scoped row for this
    region/currency and a plain currency-only row in the same currency."""
    has_region_row = any(
        p["currency_code"] == currency_code
        and any(r["attribute"] == "region_id" and r["value"] == region_id for r in p["rules"])
        for p in prices
    )
    has_currency_only_row = any(
        p["currency_code"] == currency_code and not p["rules"]
        for p in prices
    )
    return has_region_row and has_currency_only_row


def run():
    if not PUBLISHABLE_KEY:
        log.warning("MEDUSA_PUBLISHABLE_KEY is not set. Skipping the Store API cross-check.")

    token = login()
    regions = list_regions(token)
    flagged = 0

    for product in iter_products(token):
        for variant in product.get("variants") or []:
            prices = variant_price_dicts(variant)

            for region in regions:
                region_id = region["id"]
                currency_code = region["currency_code"]

                if not has_region_and_currency_only_pair(prices, region_id, currency_code):
                    continue

                context = {"region_id": region_id, "currency_code": currency_code}
                expected = pick_winning_price(prices, context)
                if expected is None:
                    continue

                served = None
                if PUBLISHABLE_KEY:
                    served_variants = {
                        v["id"]: v for v in served_calculated_price(PUBLISHABLE_KEY, product["id"], region_id)
                    }
                    served_variant = served_variants.get(variant["id"]) or {}
                    served = served_variant.get("calculated_price") or {}

                served_id = served.get("id") if served else None
                served_amount = served.get("calculated_amount") if served else None

                if served_id is not None and served_id == expected["id"]:
                    continue

                log.warning(
                    "variant=%s region=%s currency=%s expected_price_id=%s expected_amount=%s "
                    "served_price_id=%s served_amount=%s",
                    variant["id"], region_id, currency_code,
                    expected["id"], expected["amount"], served_id, served_amount,
                )
                flagged += 1

    log.info("Done. %d variant/region pair(s) flagged for review. Dry run: %s", flagged, DRY_RUN)


if __name__ == "__main__":
    run()
