"""Find Medusa v2 variants that have no price in a region's currency.

Every region has one currency_code. A variant is only purchasable in that
region if its price set has a Price row in that currency. This script lists
every region and every product's variants, then reports every {variant,
region} pair that is missing a price. It only reports by default. Filling a
gap is a separate, human-approved step behind DRY_RUN.

Guide: https://www.allanninal.dev/medusa/product-has-no-price-in-a-region/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_missing_region_prices")

BASE = os.environ["MEDUSA_BACKEND_URL"]
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


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
        params={"fields": "id,name,currency_code", "limit": 1000},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["regions"]


def list_products(token):
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"{BASE}/admin/products",
            params={
                "fields": "id,title,status,*variants,*variants.prices",
                "limit": limit,
                "offset": offset,
            },
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            yield product
        offset += limit
        if offset >= body["count"]:
            return


def find_missing_region_prices(variants, regions):
    """Pure set-difference logic. No I/O.

    For each variant, build the set of lowercase currency_codes it has
    prices for. For each region, if that set does not contain the
    region's currency_code (case-insensitive), record a gap.
    """
    gaps = []
    for variant in variants:
        priced_currencies = {
            (p.get("currency_code") or "").lower()
            for p in (variant.get("prices") or [])
        }
        for region in regions:
            region_currency = (region.get("currency_code") or "").lower()
            if region_currency not in priced_currencies:
                gaps.append({
                    "variant_id": variant.get("id"),
                    "sku": variant.get("sku"),
                    "region_id": region.get("id"),
                    "region_name": region.get("name"),
                    "missing_currency_code": region.get("currency_code"),
                })
    return gaps


def fill_missing_price(token, product_id, variant_id, existing_prices, currency_code, amount):
    """Only called when DRY_RUN is false and a human supplied the amount.

    The variant update route accepts a `prices` array that upserts the
    whole price set, so we send the existing prices plus the new one.
    """
    new_prices = existing_prices + [{"currency_code": currency_code, "amount": amount}]
    r = requests.post(
        f"{BASE}/admin/products/{product_id}/variants/{variant_id}",
        json={"prices": new_prices},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["variant"]


def run():
    token = login()
    regions = list_regions(token)
    total_gaps = 0
    for product in list_products(token):
        variants = product.get("variants") or []
        gaps = find_missing_region_prices(variants, regions)
        for gap in gaps:
            log.warning(
                "Product %s variant %s (%s) has no price for region %s (%s).",
                product.get("title"), gap["variant_id"], gap["sku"],
                gap["region_name"], gap["missing_currency_code"],
            )
            total_gaps += 1
    log.info("Done. %d gap(s) %s.", total_gaps, "found" if DRY_RUN else "found (dry run off, no auto-fill wired in)")


if __name__ == "__main__":
    run()
