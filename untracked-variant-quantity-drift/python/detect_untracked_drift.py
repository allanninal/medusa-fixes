"""Find Medusa variants with manage_inventory false whose stocked_quantity
has still drifted from a saved baseline (untracked stock that should never
change, but does). Report only, never auto-writes a corrected quantity.

Guide: https://www.allanninal.dev/medusa/untracked-variant-quantity-drift/

Safe to run again and again.
"""
import os
import sys
import json
import logging

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_untracked_drift")

BASE_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
BASELINE_PATH = os.environ.get("BASELINE_PATH", "untracked_drift_baseline.json")

PRODUCT_FIELDS = (
    "id,title,*variants,variants.manage_inventory,"
    "variants.inventory_items.inventory.id,"
    "variants.inventory_items.inventory.location_levels.stocked_quantity,"
    "variants.inventory_items.inventory.location_levels.reserved_quantity,"
    "variants.inventory_items.inventory.location_levels.location_id"
)


def get_token():
    r = requests.post(
        f"{BASE_URL}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_products(token):
    headers = {"Authorization": f"Bearer {token}"}
    out, offset, limit = [], 0, 100
    while True:
        r = requests.get(
            f"{BASE_URL}/admin/products",
            params={"fields": PRODUCT_FIELDS, "limit": limit, "offset": offset},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        out.extend(body["products"])
        offset += limit
        if offset >= body["count"]:
            return out


def flatten_variants(products):
    """Reshape raw product/variant payloads into the plain records the pure
    decision function expects."""
    flat = []
    for product in products:
        for variant in product.get("variants") or []:
            inventory_items = variant.get("inventory_items") or []
            first_item = inventory_items[0]["inventory"] if inventory_items else None
            item_id = first_item["id"] if first_item else None
            levels = []
            if first_item:
                for lvl in first_item.get("location_levels") or []:
                    levels.append({
                        "locationId": lvl["location_id"],
                        "stockedQuantity": lvl["stocked_quantity"],
                    })
            flat.append({
                "variantId": variant["id"],
                "sku": variant.get("sku"),
                "productTitle": product.get("title"),
                "manageInventory": bool(variant.get("manage_inventory")),
                "inventoryItemId": item_id,
                "locationLevels": levels,
            })
    return flat


def load_baseline(path):
    try:
        with open(path) as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    return {item_id: dict(locs) for item_id, locs in raw.items()}


def save_baseline(path, variants):
    snapshot = {}
    for variant in variants:
        item_id = variant.get("inventoryItemId")
        if not item_id:
            continue
        locs = snapshot.setdefault(item_id, {})
        for level in variant.get("locationLevels") or []:
            locs[level["locationId"]] = level["stockedQuantity"]
    with open(path, "w") as f:
        json.dump(snapshot, f, indent=2, sort_keys=True)


def detect_untracked_quantity_drift(variants, baseline):
    """Pure: no I/O. variants is a list of {variantId, manageInventory,
    inventoryItemId, locationLevels: [{locationId, stockedQuantity}]}.
    baseline is inventoryItemId -> locationId -> lastKnownStockedQuantity.

    Skips tracked variants (manage_inventory true), skips variants with no
    linked inventory item or no location levels, and only reports a record
    when the delta between current and baseline quantity is nonzero, since
    any change at all on a supposedly untracked variant is suspect.
    """
    drifted = []
    for variant in variants:
        if variant.get("manageInventory"):
            continue
        item_id = variant.get("inventoryItemId")
        levels = variant.get("locationLevels") or []
        if not item_id or not levels:
            continue

        item_baseline = baseline.get(item_id) or {}
        for level in levels:
            location_id = level["locationId"]
            current = level["stockedQuantity"]
            if location_id not in item_baseline:
                continue
            base_qty = item_baseline[location_id]
            delta = current - base_qty
            if delta != 0:
                drifted.append({
                    "variantId": variant["variantId"],
                    "inventoryItemId": item_id,
                    "locationId": location_id,
                    "baselineQuantity": base_qty,
                    "currentQuantity": current,
                    "delta": delta,
                })
    return drifted


def restore_baseline_quantity(token, inventory_item_id, location_id, baseline_quantity):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(
        f"{BASE_URL}/admin/inventory-items/{inventory_item_id}/location-levels/{location_id}",
        json={"stocked_quantity": baseline_quantity},
        headers=headers,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    # An operator can pass --restore=VARIANT_ID=QTY pairs to approve a
    # specific restore. Nothing is ever inferred automatically.
    restore_map = {}
    for arg in sys.argv[1:]:
        if arg.startswith("--restore="):
            pair = arg[len("--restore="):]
            variant_id, qty = pair.split("=")
            restore_map[variant_id] = int(qty)

    token = get_token()
    products = list_products(token)
    variants = flatten_variants(products)

    baseline = load_baseline(BASELINE_PATH)
    drift = detect_untracked_quantity_drift(variants, baseline)

    if not drift:
        log.info("No drift found across %d variant(s).", len(variants))
    else:
        for record in drift:
            log.warning(
                "Drift: variant %s, inventory_item %s, location %s. "
                "baseline=%s current=%s delta=%s",
                record["variantId"], record["inventoryItemId"], record["locationId"],
                record["baselineQuantity"], record["currentQuantity"], record["delta"],
            )
        log.info("Done. %d drifted record(s) found.", len(drift))

    if not DRY_RUN and restore_map:
        by_variant = {v["variantId"]: v for v in variants}
        for variant_id, target_qty in restore_map.items():
            variant = by_variant.get(variant_id)
            if not variant or not variant["inventoryItemId"]:
                log.warning("Skipping restore for %s, variant or inventory item not found.", variant_id)
                continue
            for level in variant["locationLevels"]:
                log.info(
                    "Restoring variant %s location %s from %s to operator-confirmed %s.",
                    variant_id, level["locationId"], level["stockedQuantity"], target_qty,
                )
                restore_baseline_quantity(token, variant["inventoryItemId"], level["locationId"], target_qty)

    save_baseline(BASELINE_PATH, variants)


if __name__ == "__main__":
    run()
