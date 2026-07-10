"""Flag Medusa variants whose shown price currency disagrees with the region's currency_code.

A Region has exactly one currency_code, but the price a customer sees comes from a
separate Pricing Module record: a price row on a price_set linked to the variant.
calculated_price resolves the region's currency_code and filters the price set for a
matching row. If the region's currency changed after prices were seeded, if a price
list scoped to another currency is still active, or if no price exists for the
region's real currency, the resolver falls through to a different currency and the
storefront renders it under the region's symbol. This never auto-converts an amount.
It only ever writes a price row in the one confirmed, unambiguous case: a variant is
missing a row for the region's currency and a human already verified the amount.
Run on a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/wrong-currency-shown-for-a-region/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_currency_mismatches")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# Optional, human-confirmed amounts for the narrow missing_currency_row repair case.
# Format: "variant_id:currency_code:amount,variant_id:currency_code:amount"
# Example: "variant_01ABC:inr:1499.00"
CONFIRMED_AMOUNTS = {}
for entry in os.environ.get("CONFIRMED_AMOUNTS", "").split(","):
    entry = entry.strip()
    if not entry:
        continue
    variant_id, currency_code, amount = entry.split(":")
    CONFIRMED_AMOUNTS[(variant_id, currency_code.lower())] = float(amount)


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


def find_currency_mismatches(region, variant_prices):
    """Pure decision function. No I/O.

    region: {"id": str, "currency_code": str}
    variant_prices: [{
        "variant_id": str, "product_id": str,
        "prices": [{"id": str, "currency_code": str, "amount": float, "price_list_id": str | None}],
        "calculated_price": {"currency_code": str, "price_list_id": str | None} | None,
    }, ...]

    Returns a list of findings: {product_id, variant_id, region_id,
    expected_currency, shown_currency, price_id, price_list_id, reason}.

    reason is "calculated_mismatch" when the price the storefront actually resolved
    does not match the region's currency, or "missing_currency_row" when no raw
    price row exists for the region's currency at all (referencing the nearest
    matched price's id/price_list_id, if any row exists).
    """
    findings = []
    for vp in variant_prices:
        calculated = vp.get("calculated_price")
        if calculated and calculated.get("currency_code") != region["currency_code"]:
            findings.append({
                "product_id": vp["product_id"],
                "variant_id": vp["variant_id"],
                "region_id": region["id"],
                "expected_currency": region["currency_code"],
                "shown_currency": calculated["currency_code"],
                "price_id": None,
                "price_list_id": calculated.get("price_list_id"),
                "reason": "calculated_mismatch",
            })
            continue

        rows = vp.get("prices") or []
        matching_row = next((p for p in rows if p["currency_code"] == region["currency_code"]), None)
        if matching_row is None:
            nearest = rows[0] if rows else {}
            findings.append({
                "product_id": vp["product_id"],
                "variant_id": vp["variant_id"],
                "region_id": region["id"],
                "expected_currency": region["currency_code"],
                "shown_currency": nearest.get("currency_code"),
                "price_id": nearest.get("id"),
                "price_list_id": nearest.get("price_list_id"),
                "reason": "missing_currency_row",
            })
    return findings


def list_regions(token):
    regions = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/regions", {
            "fields": "id,name,currency_code,*countries",
            "limit": limit,
            "offset": offset,
        })
        regions.extend(data["regions"])
        offset += limit
        if offset >= data["count"]:
            return regions


def list_variant_prices_for_region(token, region_id):
    """Returns a list of {variant_id, product_id, prices, calculated_price}."""
    variant_prices = []
    offset = 0
    limit = 50
    while True:
        data = admin_get(token, "/admin/products", {
            "region_id": region_id,
            "fields": "id,title,*variants,*variants.calculated_price,*variants.prices",
            "limit": limit,
            "offset": offset,
        })
        for product in data["products"]:
            for variant in product.get("variants") or []:
                variant_prices.append({
                    "variant_id": variant["id"],
                    "product_id": product["id"],
                    "prices": variant.get("prices") or [],
                    "calculated_price": variant.get("calculated_price"),
                })
        offset += limit
        if offset >= data["count"]:
            return variant_prices


def list_active_price_lists(token):
    data = admin_get(token, "/admin/price-lists", {
        "status[]": "active",
        "fields": "id,title,status,*prices,*rules",
        "limit": 100,
    })
    return data["price_lists"]


def add_confirmed_price_row(token, variant_id, currency_code, amount):
    return admin_post(token, f"/admin/products/variants/{variant_id}/prices", {
        "prices": [{"currency_code": currency_code, "amount": amount}],
    })


def run():
    token = get_admin_token()
    regions = list_regions(token)

    total_findings = 0
    total_repaired = 0
    for region in regions:
        region_ref = {"id": region["id"], "currency_code": region["currency_code"]}
        variant_prices = list_variant_prices_for_region(token, region["id"])
        findings = find_currency_mismatches(region_ref, variant_prices)

        for finding in findings:
            total_findings += 1
            log.warning(
                "Region %s (%s): variant %s expected=%s shown=%s reason=%s price_list_id=%s",
                region["id"], region["currency_code"], finding["variant_id"],
                finding["expected_currency"], finding["shown_currency"],
                finding["reason"], finding["price_list_id"],
            )

            if finding["reason"] != "missing_currency_row":
                # calculated_mismatch, or any real FX discrepancy, is always a
                # flagged report for the merchant, never auto-repaired.
                continue

            key = (finding["variant_id"], finding["expected_currency"].lower())
            confirmed_amount = CONFIRMED_AMOUNTS.get(key)
            if confirmed_amount is None:
                log.info("  No confirmed amount for %s in %s. Flagged only, not repaired.", key[0], key[1])
                continue

            log.info(
                "  %s POST /admin/products/variants/%s/prices {\"currency_code\": \"%s\", \"amount\": %s}",
                "Would call" if DRY_RUN else "Calling",
                finding["variant_id"], finding["expected_currency"], confirmed_amount,
            )
            if not DRY_RUN:
                add_confirmed_price_row(token, finding["variant_id"], finding["expected_currency"], confirmed_amount)
            total_repaired += 1

    log.info(
        "Done. %d mismatch(es) flagged, %d %s.",
        total_findings, total_repaired, "to repair" if DRY_RUN else "repaired",
    )


if __name__ == "__main__":
    run()
