"""Find Medusa variants that collide on barcode, ean, or upc after a product
duplication, safely.

The admin Duplicate action clones a product by re-submitting its variants
through createProductsWorkflow and createProductVariantsWorkflow, the same
workflows used for a normal POST /admin/products, and it copies every
variant field verbatim, including sku, ean, upc, and barcode. The
product_variant table has unique partial indexes on those identifier
columns, scoped to deleted_at IS NULL, so a duplicated variant that carries
the same barcode as its source hits a Postgres unique constraint violation.
Medusa never auto-clears or regenerates these fields, so the failure is
deterministic, not a race condition, for any product whose variants have a
barcode-family value set.

This lists every product's variants, groups their identifier fields with a
pure decision function, and reports every value shared by more than one
product. It never overwrites a barcode automatically. The only write this
script can make is clearing one confirmed field to null on one confirmed
variant id, and only when DRY_RUN is explicitly set to false. It never
invents a replacement value. Run once, or on a schedule. Safe to run again
and again, since a resolved conflict simply stops appearing.

Guide: https://www.allanninal.dev/medusa/duplicate-product-barcode-conflict/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_barcode_conflicts")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIRMED_VARIANT_ID = os.environ.get("CONFIRMED_VARIANT_ID", "")
CONFIRMED_FIELD = os.environ.get("CONFIRMED_FIELD", "")

FIELDS = ("barcode", "ean", "upc")


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_all_variants(token):
    entries, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/products",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "fields": "id,title,variants.id,variants.sku,variants.ean,variants.upc,variants.barcode",
                "limit": limit,
                "offset": offset,
            },
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            for variant in product.get("variants") or []:
                entries.append({
                    "productId": product["id"],
                    "variantId": variant["id"],
                    "barcode": variant.get("barcode"),
                    "ean": variant.get("ean"),
                    "upc": variant.get("upc"),
                })
        offset += limit
        if offset >= body["count"]:
            return entries


def find_barcode_conflicts(variants):
    """Pure function. No I/O.

    variants: [{"productId": str, "variantId": str, "barcode": str|None,
                "ean": str|None, "upc": str|None}, ...]

    Groups variants by each non-null, non-empty value per identifier field
    (barcode, ean, upc independently). Returns only groups where entries span
    more than one distinct productId. Same-product multi-variant repeats,
    such as a color-only variant reusing the parent barcode, are not flagged.
    Sorted by field then value for deterministic output.
    """
    groups_by_field = {field: {} for field in FIELDS}

    for v in variants:
        for field in FIELDS:
            value = v.get(field)
            if value is None or value == "":
                continue
            bucket = groups_by_field[field].setdefault(value, [])
            bucket.append({"productId": v["productId"], "variantId": v["variantId"]})

    conflicts = []
    for field in FIELDS:
        for value, entries in groups_by_field[field].items():
            product_ids = {e["productId"] for e in entries}
            if len(product_ids) > 1:
                conflicts.append({"field": field, "value": value, "entries": entries})

    conflicts.sort(key=lambda c: (c["field"], c["value"]))
    return conflicts


def clear_identifier_field(token, product_id, variant_id, field):
    r = requests.post(
        f"{BASE_URL}/admin/products/{product_id}/variants/{variant_id}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={field: None},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["variant"]


def run():
    token = get_token()
    variants = list_all_variants(token)
    conflicts = find_barcode_conflicts(variants)

    if not conflicts:
        log.info("Done. No barcode, ean, or upc conflicts found across %d variant(s).", len(variants))
        return

    log.info("Found %d conflict(s).", len(conflicts))
    for c in conflicts:
        log.info("Field %s value %r shared by:", c["field"], c["value"])
        for entry in c["entries"]:
            log.info("  product_id=%s variant_id=%s", entry["productId"], entry["variantId"])

    if CONFIRMED_VARIANT_ID and CONFIRMED_FIELD:
        target = next(
            (c for c in conflicts if c["field"] == CONFIRMED_FIELD
             and any(e["variantId"] == CONFIRMED_VARIANT_ID for e in c["entries"])),
            None,
        )
        if target is None:
            log.warning(
                "CONFIRMED_VARIANT_ID %s with field %s was not found among the reported conflicts. Nothing cleared.",
                CONFIRMED_VARIANT_ID, CONFIRMED_FIELD,
            )
        else:
            product_id = next(e["productId"] for e in target["entries"] if e["variantId"] == CONFIRMED_VARIANT_ID)
            log.info(
                "%s field %s on variant %s (product %s)",
                "Would clear" if DRY_RUN else "Clearing", CONFIRMED_FIELD, CONFIRMED_VARIANT_ID, product_id,
            )
            if not DRY_RUN:
                clear_identifier_field(token, product_id, CONFIRMED_VARIANT_ID, CONFIRMED_FIELD)

    log.info("Done. %d conflict(s) reported.", len(conflicts))


if __name__ == "__main__":
    run()
