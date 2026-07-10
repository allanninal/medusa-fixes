"""Find Medusa v2 variants that can sell forever because inventory is not managed.

Every ProductVariant has a manage_inventory flag. When it is not exactly true,
Medusa's cart and checkout workflows skip the Inventory Module entirely, so the
variant is always treated as available no matter how much real stock exists.
This script lists every product's variants, classifies each one, and reports
every variant that is an oversell risk. It only reports by default. Flipping
manage_inventory on and setting a stock count is a separate, human-approved
step behind DRY_RUN, because some variants (digital goods, services, gift
cards) are deliberately left untracked.

Guide: https://www.allanninal.dev/medusa/inventory-not-managed-never-sells-out/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("classify_inventory_risk")

BASE = os.environ["MEDUSA_BACKEND_URL"]
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

DEFAULT_EXEMPT_TAGS = ("digital", "service", "gift-card")

PRODUCT_FIELDS = (
    "id,title,status,tags,*variants,variants.manage_inventory,variants.sku,"
    "*variants.inventory_items,*variants.inventory_items.inventory,"
    "*variants.inventory_items.inventory.location_levels"
)


def login():
    r = requests.post(
        f"{BASE}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_products(token):
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"{BASE}/admin/products",
            params={"fields": PRODUCT_FIELDS, "limit": limit, "offset": offset},
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


def variant_records(product):
    tags = [t.get("value") for t in (product.get("tags") or []) if t.get("value")]
    records = []
    for variant in product.get("variants") or []:
        records.append({
            "id": variant.get("id"),
            "sku": variant.get("sku"),
            "manage_inventory": variant.get("manage_inventory"),
            "inventory_items": variant.get("inventory_items") or [],
            "product_tags": tags,
            "product_id": product.get("id"),
            "product_title": product.get("title"),
        })
    return records


def _has_stock(inventory_item):
    inventory = inventory_item.get("inventory") or {}
    levels = inventory.get("location_levels") or []
    return any((lvl.get("stocked_quantity") or 0) > 0 for lvl in levels)


def classify_variant_inventory_risk(variant, exempt_tags=DEFAULT_EXEMPT_TAGS):
    tags = variant.get("product_tags") or []
    if any(tag in exempt_tags for tag in tags):
        return "exempt"
    if variant.get("manage_inventory") is not True:
        return "unmanaged_risk"
    items = variant.get("inventory_items") or []
    if len(items) == 0 or not any(_has_stock(item) for item in items):
        return "managed_but_untracked"
    return "ok"


def enable_manage_inventory(token, product_id, variant_id):
    """Only called when DRY_RUN is false and a human confirmed this variant."""
    r = requests.post(
        f"{BASE}/admin/products/{product_id}/variants/{variant_id}",
        json={"manage_inventory": True},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["variant"]


def ensure_location_level(token, inventory_item_id, location_id, stocked_quantity):
    """Only called when DRY_RUN is false and a human supplied stocked_quantity."""
    r = requests.get(
        f"{BASE}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    levels = r.json().get("inventory_levels", [])
    if levels:
        return levels
    r = requests.post(
        f"{BASE}/admin/inventory-items/{inventory_item_id}/location-levels",
        json={"location_id": location_id, "stocked_quantity": stocked_quantity},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = login()
    flagged = 0
    for product in list_products(token):
        for variant in variant_records(product):
            risk = classify_variant_inventory_risk(variant)
            if risk in ("ok", "exempt"):
                continue
            log.warning(
                "Product %s variant %s (sku=%s) manage_inventory=%s inventory_items=%d risk=%s",
                variant["product_title"], variant["id"], variant["sku"],
                variant["manage_inventory"], len(variant["inventory_items"]), risk,
            )
            flagged += 1
    log.info("Done. %d variant(s) %s.", flagged, "flagged" if DRY_RUN else "flagged (dry run off, no auto-fix wired in)")


if __name__ == "__main__":
    run()
