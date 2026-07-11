"""Find Medusa variants whose option pairing got scrambled by product duplication.

Medusa links a ProductVariant to its options by title to value pairing, for
example options: {"Size": "Small", "Color": "Red"}, not by a stable positional
index. When a product is duplicated, its ProductOption and ProductOptionValue
rows are recreated on the copy with brand new ids, and the duplication step
re-attaches each new variant to that new set. If that re-attachment happens by
creation order instead of by matching each source variant's actual title and
value pairing, a variant in the duplicate can land on the wrong value even
though the variant count and SKUs still look correct.

This fetches the source product and the duplicate product, normalizes every
variant's options into a canonical signature string with a pure function, and
reports every duplicate variant whose signature does not match its source
counterpart. It never writes to the option or option value tables directly,
since those are owned by the product module's own linking logic. The only
write this script can make is correcting a mismatched variant's options
through the existing variant update route, and it only does that when
DRY_RUN is explicitly set to false. Run once per source and duplicate pair.
Safe to run again and again, since a corrected variant simply stops appearing
in the report.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diff_variant_options")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

FIELDS = "id,title,*options,*options.values,*variants,*variants.sku,*variants.options,*variants.options.option"


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/admin/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_product(token, product_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/products/{product_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": FIELDS},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def normalize_variants(product):
    """Turn the raw API shape into [{"sku": str, "options": [{"title": str, "value": str}]}]."""
    normalized = []
    for v in product.get("variants") or []:
        pairs = []
        for opt in v.get("options") or []:
            title = (opt.get("option") or {}).get("title")
            value = opt.get("value")
            if title is not None and value is not None:
                pairs.append({"title": title, "value": value})
        normalized.append({"sku": v.get("sku"), "options": pairs})
    return normalized


def signature(options):
    pairs = sorted(options, key=lambda p: p["title"])
    return "|".join(f'{p["title"]}:{p["value"]}' for p in pairs)


def diff_variant_option_signatures(source_variants, dup_variants):
    """Pure function. No I/O.

    source_variants / dup_variants: [{"sku": str, "options": [{"title": str, "value": str}]}]

    Matches by sku when both sides carry unique skus, falls back to index when
    sku is missing or collides. Returns [{"sku": str, "expected": str,
    "actual": str}] only for variants whose signature differs.
    """
    use_index = (
        not source_variants
        or not dup_variants
        or any(not v.get("sku") for v in source_variants)
        or any(not v.get("sku") for v in dup_variants)
        or len({v.get("sku") for v in source_variants}) != len(source_variants)
        or len({v.get("sku") for v in dup_variants}) != len(dup_variants)
    )

    mismatches = []
    if use_index:
        for i in range(min(len(source_variants), len(dup_variants))):
            src, dup = source_variants[i], dup_variants[i]
            expected, actual = signature(src["options"]), signature(dup["options"])
            if expected != actual:
                mismatches.append({"sku": dup.get("sku") or src.get("sku") or f"#{i}", "expected": expected, "actual": actual})
        return mismatches

    by_sku = {v["sku"]: v for v in dup_variants}
    for src in source_variants:
        dup = by_sku.get(src["sku"])
        if dup is None:
            continue
        expected, actual = signature(src["options"]), signature(dup["options"])
        if expected != actual:
            mismatches.append({"sku": src["sku"], "expected": expected, "actual": actual})
    return mismatches


def fix_variant_options(token, product_id, variant_id, options_map):
    r = requests.post(
        f"{BACKEND_URL}/admin/products/{product_id}/variants/{variant_id}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"options": options_map},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def run(source_product_id=None, duplicate_product_id=None):
    source_product_id = source_product_id or os.environ["SOURCE_PRODUCT_ID"]
    duplicate_product_id = duplicate_product_id or os.environ["DUPLICATE_PRODUCT_ID"]

    token = get_admin_token()
    source = get_product(token, source_product_id)
    duplicate = get_product(token, duplicate_product_id)

    source_variants = normalize_variants(source)
    dup_variants = normalize_variants(duplicate)
    mismatches = diff_variant_option_signatures(source_variants, dup_variants)

    if not mismatches:
        log.info("Done. No scrambled variants found between %s and %s.", source_product_id, duplicate_product_id)
        return

    log.info("Found %d scrambled variant(s) on duplicate %s.", len(mismatches), duplicate_product_id)
    dup_variant_by_sku = {v.get("sku"): v for v in duplicate.get("variants") or []}
    for m in mismatches:
        log.info("  sku=%s expected=%r actual=%r", m["sku"], m["expected"], m["actual"])

        if not DRY_RUN:
            variant = dup_variant_by_sku.get(m["sku"])
            if variant is None:
                continue
            options_map = {pair.split(":", 1)[0]: pair.split(":", 1)[1] for pair in m["expected"].split("|") if pair}
            log.info("  Fixing variant %s to %s", variant["id"], options_map)
            fix_variant_options(token, duplicate_product_id, variant["id"], options_map)
        else:
            log.info("  Would fix this variant to match the expected signature.")

    log.info("Done. %d scrambled variant(s) %s.", len(mismatches), "to fix" if DRY_RUN else "fixed")


if __name__ == "__main__":
    run()
