"""Repair Medusa variants whose CSV import never set a stocked quantity.

In Medusa v2, stock lives on a location_levels record under a linked
inventory_item, in stocked_quantity, not on the variant itself.
importProductsWorkflow creates the inventory item for each variant, but its
CSV normalization step does not map the legacy Variant Inventory Quantity
column to a location level creation step, tracked upstream as
medusajs/medusa issues 11605 and 9357. Every imported variant can end up
with no location level, or one stuck at zero, no matter what the source CSV
said. This reads back the variants an import batch created, compares each
one's actual location levels against the source CSV row for its SKU, and
either logs or writes the missing stocked_quantity. Run once after an
import. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/csv-import-ignores-inventory-quantity/
"""
import os
import csv
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("repair_import_inventory")

BACKEND_URL = os.environ.get("MEDUSA_BACKEND_URL", "http://localhost:9000")
ADMIN_EMAIL = os.environ.get("MEDUSA_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("MEDUSA_ADMIN_PASSWORD", "supersecret")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
BATCH_TAG = os.environ.get("IMPORT_BATCH_TAG", "")
CSV_PATH = os.environ.get("IMPORT_CSV_PATH", "import.csv")
DEFAULT_LOCATION_ID = os.environ.get("DEFAULT_LOCATION_ID", "")


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_imported_products(token, batch_tag):
    r = requests.get(
        f"{BACKEND_URL}/admin/products",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "q": batch_tag,
            "fields": "id,title,*variants,*variants.inventory_items,*variants.inventory_items.inventory",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["products"]


def get_location_levels(token, inventory_item_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "location_id,stocked_quantity"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["inventory_levels"]


def read_csv_rows_by_sku(csv_path):
    rows = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sku = row.get("Variant SKU") or row.get("sku")
            qty = row.get("Variant Inventory Quantity") or row.get("variant_inventory_quantity") or "0"
            if sku:
                rows[sku] = {"sku": sku, "variantInventoryQuantity": int(float(qty))}
    return rows


def decide_inventory_repair(csv_row, variant, location_levels, default_location_id):
    """Pure decision function. No I/O.

    csv_row: {"sku": str, "variantInventoryQuantity": int}
    variant: {"id": str, "sku": str, "inventoryItemId": str | None}
    location_levels: [{"location_id": str, "stocked_quantity": number}, ...]
    default_location_id: str

    Returns a repair action dict, or None if nothing needs to change:
      {"action": "create_level" | "update_level", "inventoryItemId": str,
       "locationId": str, "fromQty": int, "toQty": int}
    """
    if csv_row.get("variantInventoryQuantity", 0) <= 0:
        return None
    if not variant.get("inventoryItemId"):
        return None

    if not location_levels:
        return {
            "action": "create_level",
            "inventoryItemId": variant["inventoryItemId"],
            "locationId": default_location_id,
            "fromQty": 0,
            "toQty": csv_row["variantInventoryQuantity"],
        }

    level = next((lvl for lvl in location_levels if lvl.get("location_id") == default_location_id), None)
    if level is None:
        return {
            "action": "create_level",
            "inventoryItemId": variant["inventoryItemId"],
            "locationId": default_location_id,
            "fromQty": 0,
            "toQty": csv_row["variantInventoryQuantity"],
        }

    if level.get("stocked_quantity", 0) != csv_row["variantInventoryQuantity"]:
        return {
            "action": "update_level",
            "inventoryItemId": variant["inventoryItemId"],
            "locationId": default_location_id,
            "fromQty": level.get("stocked_quantity", 0),
            "toQty": csv_row["variantInventoryQuantity"],
        }

    return None


def create_location_level(token, inventory_item_id, location_id, stocked_quantity):
    r = requests.post(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels",
        headers={"Authorization": f"Bearer {token}"},
        json={"location_id": location_id, "stocked_quantity": stocked_quantity},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def update_location_level(token, inventory_item_id, location_id, stocked_quantity):
    r = requests.post(
        f"{BACKEND_URL}/admin/inventory-items/{inventory_item_id}/location-levels/{location_id}",
        headers={"Authorization": f"Bearer {token}"},
        json={"stocked_quantity": stocked_quantity},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    if not DEFAULT_LOCATION_ID:
        raise SystemExit("Set DEFAULT_LOCATION_ID to the stock location the CSV quantity should land on.")

    token = get_admin_token()
    csv_rows = read_csv_rows_by_sku(CSV_PATH)
    products = get_imported_products(token, BATCH_TAG)

    repaired = 0
    skipped_no_inventory_item = 0

    for product in products:
        for variant in product.get("variants") or []:
            sku = variant.get("sku")
            csv_row = csv_rows.get(sku)
            if not csv_row:
                continue

            inventory_items = variant.get("inventory_items") or []
            inventory_item_id = None
            if inventory_items:
                inventory_item_id = (inventory_items[0].get("inventory") or {}).get("id") or inventory_items[0].get("inventory_item_id")

            variant_input = {
                "id": variant["id"],
                "sku": sku,
                "inventoryItemId": inventory_item_id,
            }

            if csv_row["variantInventoryQuantity"] > 0 and not inventory_item_id:
                skipped_no_inventory_item += 1
                log.warning(
                    "Variant %s (SKU %s): CSV expected %s units but has no inventory item, flagging for manual review",
                    variant["id"], sku, csv_row["variantInventoryQuantity"],
                )
                continue

            location_levels = get_location_levels(token, inventory_item_id) if inventory_item_id else []
            decision = decide_inventory_repair(csv_row, variant_input, location_levels, DEFAULT_LOCATION_ID)
            if decision is None:
                continue

            log.info(
                "%s variant %s (SKU %s): location %s, %s -> %s",
                "Would repair" if DRY_RUN else "Repairing",
                variant["id"], sku, decision["locationId"], decision["fromQty"], decision["toQty"],
            )

            if not DRY_RUN:
                if decision["action"] == "create_level":
                    create_location_level(token, decision["inventoryItemId"], decision["locationId"], decision["toQty"])
                elif decision["action"] == "update_level":
                    update_location_level(token, decision["inventoryItemId"], decision["locationId"], decision["toQty"])

            repaired += 1

    log.info("Done. %d variant(s) %s, %d flagged with no inventory item.",
              repaired, "to repair" if DRY_RUN else "repaired", skipped_no_inventory_item)


if __name__ == "__main__":
    run()
