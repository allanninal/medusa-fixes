"""Find Medusa products whose variants have an options mismatch that would
block creation: a missing option title, an extra title, or an invalid value.
Report only. Never guesses or writes a variant's option value.
Safe to run again and again.
"""
import os
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_variant_options_mismatch")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PRODUCT_FIELDS = (
    "id,title,*options,*options.values,*variants,"
    "*variants.options,*variants.options.option"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_products(token, limit=100):
    headers = {"Authorization": f"Bearer {token}"}
    offset = 0
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/products",
            params={"fields": PRODUCT_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            yield product
        offset += limit
        if offset >= body["count"]:
            return


def normalize_variant_options(variant):
    """Accepts either the expanded admin shape (a list of
    {option: {title}, value}) or an already-flat {title: value} map,
    and returns a plain {title: value} dict either way."""
    raw = variant.get("options")
    if isinstance(raw, dict):
        return dict(raw)
    flat = {}
    for entry in raw or []:
        title = (entry.get("option") or {}).get("title")
        if title:
            flat[title] = entry.get("value")
    return flat


def find_incomplete_variants(product):
    """Pure: no I/O. Returns a list of {variant_id, variant_title,
    missing_titles, extra_titles, invalid_values} for every variant whose
    normalized options do not exactly match the product's option set."""
    options = product.get("options") or []
    required_titles = {o["title"] for o in options}
    values_by_title = {o["title"]: {v["value"] for v in (o.get("values") or [])} for o in options}

    results = []
    for variant in product.get("variants") or []:
        variant_options = normalize_variant_options(variant)
        variant_titles = set(variant_options.keys())

        missing_titles = sorted(required_titles - variant_titles)
        extra_titles = sorted(variant_titles - required_titles)
        invalid_values = []
        for title, value in variant_options.items():
            if title in required_titles and value not in values_by_title.get(title, set()):
                invalid_values.append({"title": title, "value": value})

        if missing_titles or extra_titles or invalid_values:
            results.append({
                "variant_id": variant.get("id"),
                "variant_title": variant.get("title"),
                "missing_titles": missing_titles,
                "extra_titles": extra_titles,
                "invalid_values": invalid_values,
            })
    return results


def run():
    token = get_token()
    flagged_products = 0
    flagged_variants = 0

    for product in list_products(token):
        mismatches = find_incomplete_variants(product)
        if not mismatches:
            continue
        flagged_products += 1
        for m in mismatches:
            flagged_variants += 1
            log.info(
                "%s product %s (%s) variant %s (%s): missing=%s extra=%s invalid=%s",
                "Would flag" if DRY_RUN else "Flagging",
                product.get("id"), product.get("title"),
                m["variant_id"], m["variant_title"],
                m["missing_titles"], m["extra_titles"], m["invalid_values"],
            )

    log.info(
        "Done. %d product(s), %d variant(s) flagged for merchant follow-up.",
        flagged_products, flagged_variants,
    )


if __name__ == "__main__":
    run()
