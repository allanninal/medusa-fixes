"""Reconcile Medusa reservations whose update event never fired.

Medusa v2's InventoryModuleService.updateReservationItem emitted the wrong
event constant (confirmed in medusajs/medusa#11704, fixed in PR #11714): it
fired inventory-item.updated instead of reservation-item.updated whenever a
reservation's quantity, line item, or location changed, whether from the
admin UI, the Admin API, or an internal workflow like order fulfillment or
cancellation. A subscriber registered for RESERVATION_ITEM_UPDATED never
receives that change, so a stock-sync integration built on it silently
drifts. This lists reservations per stock location, diffs their live
quantity against a last-synced snapshot, and cross-checks reserved_quantity
at each location level against the sum of live reservations there.
By default it only reports drift. Pass --apply (with DRY_RUN=false) to also
update the sync baseline and forward the corrected delta downstream.
Run as a scheduled reconciler. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/reservation-updated-event-not-firing/
"""
import os
import sys
import json
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("reconcile_reservation_sync")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SYNC_STATE_PATH = os.environ.get("SYNC_STATE_PATH", "reservation_sync_state.json")


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


def diff_reservation_sync(live, last_synced):
    """Pure decision function. No I/O.

    live: [{"id": str, "quantity": int, "location_id": str, "updated_at": str}]
    last_synced: {res_id: {"quantity": int, "updated_at": str}}

    Returns [{"id", "drift", "stale_since"}] for every reservation whose
    live quantity differs from (or is missing from) the last-synced map.
    This is the exact recomputation a working RESERVATION_ITEM_UPDATED
    subscriber would have done incrementally, one event at a time.
    """
    drifted = []
    for r in live:
        prev = last_synced.get(r["id"])
        if prev is not None and prev["quantity"] == r["quantity"]:
            continue
        prev_quantity = prev["quantity"] if prev else 0
        stale_since = prev["updated_at"] if prev else r["updated_at"]
        drifted.append({
            "id": r["id"],
            "drift": r["quantity"] - prev_quantity,
            "stale_since": stale_since,
        })
    return drifted


def location_level_mismatches(reservations_by_location, location_levels):
    """Pure decision function. No I/O.

    reservations_by_location: {location_id: [{"quantity", "inventory_item_id"}]}
    location_levels: [{"location_id", "reserved_quantity", "inventory_item_id"}]

    Flags a location level whose reserved_quantity does not equal the sum
    of live reservation quantities for that location and inventory item.
    """
    mismatches = []
    for level in location_levels:
        live_sum = sum(
            r["quantity"] for r in reservations_by_location.get(level["location_id"], [])
            if r["inventory_item_id"] == level["inventory_item_id"]
        )
        if live_sum != level["reserved_quantity"]:
            mismatches.append({
                "location_id": level["location_id"],
                "inventory_item_id": level["inventory_item_id"],
                "reserved_quantity": level["reserved_quantity"],
                "live_sum": live_sum,
            })
    return mismatches


def list_stock_locations(token):
    data = admin_get(token, "/admin/stock-locations", {"limit": 200})
    return data["stock_locations"]


def list_reservations_for_location(token, location_id):
    reservations = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(token, "/admin/reservations", {
            "location_id": location_id,
            "fields": "id,quantity,line_item_id,inventory_item_id,location_id,updated_at,*inventory_item",
            "limit": limit,
            "offset": offset,
        })
        reservations.extend(data["reservations"])
        offset += limit
        if offset >= data["count"]:
            return reservations


def fetch_location_levels(token, inventory_item_id):
    data = admin_get(token, f"/admin/inventory-items/{inventory_item_id}/location-levels")
    return data["inventory_item"]["location_levels"]


def load_sync_state(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def save_sync_state(path, state):
    with open(path, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)


def forward_delta(res_id, drift):
    """Push the corrected reserved delta to whatever external system this
    stock-sync consumer feeds. Replace with a real integration call.
    """
    log.info("Forwarding corrected delta for %s: %+d to downstream stock system", res_id, drift)


def run():
    apply_flag = "--apply" in sys.argv
    token = get_admin_token()
    sync_state = load_sync_state(SYNC_STATE_PATH)

    locations = list_stock_locations(token)
    all_reservations = []
    reservations_by_location = {}
    for location in locations:
        loc_id = location["id"]
        res_list = list_reservations_for_location(token, loc_id)
        reservations_by_location[loc_id] = res_list
        all_reservations.extend(res_list)

    drifted = diff_reservation_sync(all_reservations, sync_state)

    for entry in drifted:
        log.warning(
            "Reservation %s drifted (%+d) stale since %s. %s",
            entry["id"], entry["drift"], entry["stale_since"],
            "Would update baseline" if DRY_RUN or not apply_flag else "Updating baseline",
        )
        if not DRY_RUN and apply_flag:
            live = next(r for r in all_reservations if r["id"] == entry["id"])
            sync_state[entry["id"]] = {"quantity": live["quantity"], "updated_at": live["updated_at"]}
            forward_delta(entry["id"], entry["drift"])

    inventory_item_ids = {r["inventory_item_id"] for r in all_reservations}
    all_mismatches = []
    for iitem_id in inventory_item_ids:
        levels = fetch_location_levels(token, iitem_id)
        mismatches = location_level_mismatches(reservations_by_location, levels)
        all_mismatches.extend(mismatches)

    for mismatch in all_mismatches:
        log.warning(
            "Location level mismatch at %s for %s: reserved_quantity=%s live_sum=%s",
            mismatch["location_id"], mismatch["inventory_item_id"],
            mismatch["reserved_quantity"], mismatch["live_sum"],
        )

    if not DRY_RUN and apply_flag:
        save_sync_state(SYNC_STATE_PATH, sync_state)

    log.info(
        "Done. %d drifted reservation(s), %d location level mismatch(es). %s",
        len(drifted), len(all_mismatches),
        "Baseline updated" if (not DRY_RUN and apply_flag) else "Report only",
    )


if __name__ == "__main__":
    run()
