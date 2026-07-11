"""Detect Medusa publishable keys whose multi-channel scope makes variants read zero stock.

In Medusa v2, the Store API is supposed to resolve a variant's available inventory
by unioning the stock locations linked to every sales channel a publishable key is
scoped to, then summing stocked_quantity minus reserved_quantity across those
locations. A known bug (medusajs/medusa#7907, and the related sales_channel_id
stripping regression in #12209) only handles a key scoped to exactly one sales
channel. When a key is scoped to more than one, the location filter can be
silently narrowed to a single channel or dropped entirely, so the join returns
no rows and inventory_quantity is computed as 0 even though the admin API shows
real stock at the linked locations.

This script never writes anything, in DRY_RUN or not, because the defect lives in
Medusa core's request-scoping logic (or a custom middleware reproducing it), not
in the store's data. It only reads the admin's location levels and the Store
API's reported quantity for a sample of products under a real publishable key,
classifies each variant with a pure decision function, and reports every mismatch
whose fingerprint matches this bug.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_multi_channel_zero_stock")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
PUBLISHABLE_KEY = os.environ["MEDUSA_PUBLISHABLE_KEY"]
PUBLISHABLE_KEY_ID = os.environ.get("MEDUSA_PUBLISHABLE_KEY_ID", "").strip() or None
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"  # no write path exists either way


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


def key_sales_channel_ids(token, key_id):
    data = admin_get(token, f"/admin/api-keys/{key_id}", {"fields": "id,*sales_channels"})
    channels = data["api_key"]["sales_channels"] or []
    return [ch["id"] for ch in channels]


def stock_locations_by_channel(token, sales_channel_ids):
    data = admin_get(token, "/admin/stock-locations", {"fields": "id,name,*sales_channels", "limit": 200})
    locations = data["stock_locations"]
    by_channel = {sc_id: [] for sc_id in sales_channel_ids}
    for loc in locations:
        for ch in loc.get("sales_channels") or []:
            if ch["id"] in by_channel:
                by_channel[ch["id"]].append(loc["id"])
    return by_channel


def admin_location_levels_by_location_id(token, product_id):
    data = admin_get(
        token,
        f"/admin/products/{product_id}",
        {
            "fields": "id,*variants.inventory_items.inventory.location_levels.stocked_quantity,"
                      "*variants.inventory_items.inventory.location_levels.reserved_quantity",
        },
    )
    product = data["product"]
    levels_by_variant = {}
    for variant in product.get("variants") or []:
        by_location = {}
        for item in variant.get("inventory_items") or []:
            inventory = item.get("inventory") or {}
            for lvl in inventory.get("location_levels") or []:
                by_location[lvl["location_id"]] = {
                    "stockedQuantity": lvl["stocked_quantity"],
                    "reservedQuantity": lvl["reserved_quantity"],
                }
        levels_by_variant[variant["id"]] = by_location
    return product, levels_by_variant


def store_inventory_quantities(publishable_key, product_id):
    r = requests.get(
        f"{BACKEND_URL}/store/products/{product_id}",
        headers={"x-publishable-api-key": publishable_key},
        params={"fields": "id,title,*variants.inventory_quantity"},
        timeout=30,
    )
    r.raise_for_status()
    product = r.json()["product"]
    return {v["id"]: v.get("inventory_quantity") for v in product.get("variants") or []}


def diagnose_zero_stock_mismatch(
    publishable_key_scope_sales_channel_ids,
    admin_location_levels_by_location_id,
    expected_stock_location_ids_by_channel,
    store_reported_inventory_quantity,
):
    """Pure decision function. No I/O.

    publishable_key_scope_sales_channel_ids: [str, ...]
    admin_location_levels_by_location_id: {location_id: {"stockedQuantity": int, "reservedQuantity": int}}
    expected_stock_location_ids_by_channel: {sales_channel_id: [location_id, ...]}
    store_reported_inventory_quantity: int

    Returns {"isBug": bool, "expectedAvailable": int, "reason": str}.
    """
    expected_location_ids = set()
    for channel_id in publishable_key_scope_sales_channel_ids:
        expected_location_ids.update(expected_stock_location_ids_by_channel.get(channel_id, []))

    expected_available = 0
    for location_id in expected_location_ids:
        level = admin_location_levels_by_location_id.get(location_id)
        if not level:
            continue
        expected_available += max(level["stockedQuantity"] - level["reservedQuantity"], 0)

    is_multi_channel = len(publishable_key_scope_sales_channel_ids) > 1
    if is_multi_channel and expected_available > 0 and store_reported_inventory_quantity == 0:
        return {"isBug": True, "expectedAvailable": expected_available, "reason": "multi-channel-key-zero-stock"}
    if expected_available <= 0:
        return {"isBug": False, "expectedAvailable": expected_available, "reason": "genuinely-out-of-stock"}
    return {"isBug": False, "expectedAvailable": expected_available, "reason": "ok"}


def sample_product_ids(token, limit=25):
    data = admin_get(token, "/admin/products", {"limit": limit, "fields": "id"})
    return [p["id"] for p in data["products"]]


def run():
    token = get_admin_token()
    if not PUBLISHABLE_KEY_ID:
        raise RuntimeError("Set MEDUSA_PUBLISHABLE_KEY_ID to the api key's admin id (pk_...) to resolve its scope.")

    channel_ids = key_sales_channel_ids(token, PUBLISHABLE_KEY_ID)
    expected_locations_by_channel = stock_locations_by_channel(token, channel_ids)
    log.info("Key %s is scoped to %d sales channel(s).", PUBLISHABLE_KEY_ID, len(channel_ids))

    mismatches = 0
    for product_id in sample_product_ids(token):
        product, levels_by_variant = admin_location_levels_by_location_id(token, product_id)
        store_quantities = store_inventory_quantities(PUBLISHABLE_KEY, product_id)

        for variant in product.get("variants") or []:
            variant_id = variant["id"]
            store_qty = store_quantities.get(variant_id)
            if store_qty is None:
                continue
            decision = diagnose_zero_stock_mismatch(
                channel_ids,
                levels_by_variant.get(variant_id, {}),
                expected_locations_by_channel,
                store_qty,
            )
            if decision["isBug"]:
                mismatches += 1
                log.warning(
                    "MISMATCH product=%s variant=%s key=%s channels=%d admin_expected=%d store_reported=%s reason=%s",
                    product_id, variant_id, PUBLISHABLE_KEY_ID, len(channel_ids),
                    decision["expectedAvailable"], store_qty, decision["reason"],
                )

    log.info("Done. %d mismatch(es) found. No write operations were performed (DRY_RUN=%s).", mismatches, DRY_RUN)


if __name__ == "__main__":
    run()
