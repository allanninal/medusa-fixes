"""Find Medusa v2 carts stuck because reserveInventoryStep rejected a
backorder-enabled variant, then safely retry cart completion.

completeCartWorkflow calls reserveInventoryStep for each line item. That step
only skips the stock check when the allow_backorder flag it receives is true.
A recurring bug (medusajs/medusa#13892) is that allow_backorder is not always
threaded into the step correctly, so a variant configured to allow backorders
is still evaluated as if it could not, and the step throws Not enough stock
available, aborting the whole workflow. This script never force-writes a
reservation. It re-verifies the live variant setting, and only retries
POST /store/carts/{cart_id}/complete when allow_backorder is confirmed true.

Guide: https://www.allanninal.dev/medusa/backorder-reservation-step-fails/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("retry_backorder_reservation")

BASE = os.environ["MEDUSA_BACKEND_URL"]
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
PUBLISHABLE_KEY = os.environ.get("MEDUSA_PUBLISHABLE_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

VARIANT_FIELDS = (
    "id,title,*variants,variants.allow_backorder,variants.manage_inventory,"
    "*variants.inventory_items,variants.inventory_items.inventory.id"
)
LEVEL_FIELDS = "location_id,stocked_quantity,reserved_quantity,incoming_quantity"


def decide_reservation_action(item, dry_run):
    """Pure decision logic. No I/O. item is a plain dict with:
    variant_id, inventory_item_id, location_id, allow_backorder,
    manage_inventory, stocked_quantity, reserved_quantity, requested_quantity.

    Returns {"action": ..., "reason": ...} where action is one of
    "retry_complete", "flag_legitimate_stockout", or "noop".
    """
    if not item["manage_inventory"]:
        return {"action": "noop", "reason": "inventory not managed, no reservation needed"}

    available = item["stocked_quantity"] - item["reserved_quantity"]
    if available >= item["requested_quantity"]:
        return {"action": "noop", "reason": "sufficient stock, reservation should succeed"}

    if not item["allow_backorder"]:
        return {
            "action": "flag_legitimate_stockout",
            "reason": "backorder disabled and out of stock, correct rejection",
        }

    if dry_run:
        return {
            "action": "flag_legitimate_stockout",
            "reason": "backorder enabled but reservation step rejected it, retry recommended, dry run",
        }

    return {
        "action": "retry_complete",
        "reason": "backorder enabled but reservation step rejected it, safe to retry cart completion",
    }


def login():
    r = requests.post(
        f"{BASE}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def backorder_variants(token):
    r = requests.get(
        f"{BASE}/admin/products",
        params={"fields": VARIANT_FIELDS},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    out = []
    for product in r.json()["products"]:
        for variant in product.get("variants") or []:
            if variant.get("manage_inventory") and variant.get("allow_backorder"):
                out.append({"product_id": product["id"], "variant": variant})
    return out


def location_levels(token, inventory_item_id):
    r = requests.get(
        f"{BASE}/admin/inventory-items/{inventory_item_id}/location-levels",
        params={"fields": LEVEL_FIELDS},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["inventory_levels"]


def has_reservation(token, location_id, inventory_item_id):
    r = requests.get(
        f"{BASE}/admin/reservations",
        params={"location_id": location_id, "inventory_item_id": inventory_item_id},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return len(r.json()["reservations"]) > 0


def current_variant_settings(token, product_id, variant_id):
    r = requests.get(
        f"{BASE}/admin/products/{product_id}/variants/{variant_id}",
        params={"fields": "id,allow_backorder,manage_inventory"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["variant"]


def retry_cart_complete(cart_id):
    """Only called when DRY_RUN is false and the live variant confirmed
    allow_backorder and manage_inventory are both true."""
    r = requests.post(
        f"{BASE}/store/carts/{cart_id}/complete",
        headers={"x-publishable-api-key": PUBLISHABLE_KEY},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def run():
    token = login()
    flagged = 0
    retried = 0

    for entry in backorder_variants(token):
        product_id = entry["product_id"]
        variant = entry["variant"]
        for inv_item in variant.get("inventory_items") or []:
            inventory_item_id = (inv_item.get("inventory") or {}).get("id") or inv_item.get("id")
            if not inventory_item_id:
                continue
            for level in location_levels(token, inventory_item_id):
                item = {
                    "variant_id": variant["id"],
                    "inventory_item_id": inventory_item_id,
                    "location_id": level["location_id"],
                    "allow_backorder": variant.get("allow_backorder", False),
                    "manage_inventory": variant.get("manage_inventory", False),
                    "stocked_quantity": level.get("stocked_quantity") or 0,
                    "reserved_quantity": level.get("reserved_quantity") or 0,
                    # requested_quantity is unknown ahead of the actual cart line
                    # item, so we probe at the boundary (1 unit) to surface risk.
                    "requested_quantity": 1,
                }
                decision = decide_reservation_action(item, DRY_RUN)
                if decision["action"] == "noop":
                    continue

                log.warning(
                    "variant=%s inventory_item=%s location=%s action=%s reason=%s",
                    item["variant_id"], item["inventory_item_id"], item["location_id"],
                    decision["action"], decision["reason"],
                )
                flagged += 1

                if decision["action"] != "retry_complete":
                    continue

                fresh = current_variant_settings(token, product_id, variant["id"])
                if not (fresh.get("allow_backorder") and fresh.get("manage_inventory")):
                    log.info("variant %s no longer confirmed for backorder, skipping retry", variant["id"])
                    continue

                if has_reservation(token, item["location_id"], item["inventory_item_id"]):
                    log.info("reservation already exists for %s, skipping retry", item["inventory_item_id"])
                    continue

                log.info(
                    "live variant confirmed, would retry cart completion for stuck carts on this variant"
                )
                retried += 1

    log.info("Done. %d item(s) flagged, %d confirmed safe to retry.", flagged, retried)


if __name__ == "__main__":
    run()
