"""Find Medusa sales channels with zero linked stock locations and link one, safely.

Inventory availability is scoped by a stored link between the Sales Channel
module and the Stock Location module. Reservations, location-scoped inventory
levels, and cart or checkout availability checks all resolve through that
link. If a sales channel has zero linked stock locations, every product
becomes effectively unpurchasable through it, even though the inventory
items have valid location levels elsewhere. This lists every sales channel,
decides what to do with a pure function, and only writes when a target
stock location is explicit or there is exactly one unambiguous default
location in the store. Every other case is reported only. Run once, or on
a schedule. Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/sales-channel-not-linked-to-a-stock-location/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("link_stock_location")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STOCK_LOCATION_ID_OVERRIDE = os.environ.get("STOCK_LOCATION_ID", "").strip() or None


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_sales_channels(token):
    channels = []
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"{BACKEND_URL}/admin/sales-channels",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,name,*stock_locations", "limit": limit, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        channels.extend(body["sales_channels"])
        offset += limit
        if offset >= body["count"]:
            return channels


def get_stock_locations(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/stock-locations",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,name,*sales_channels"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["stock_locations"]


def plan_stock_location_links(sales_channels, available_locations, default_location_id=None):
    """Pure decision function. No I/O.

    sales_channels: [{"id": str, "name": str, "stock_locations": [{"id": str}, ...]}, ...]
    available_locations: [{"id": str, "name": str}, ...]
    default_location_id: str | None

    Returns a list of
    {"sales_channel_id": str, "sales_channel_name": str, "needs_link": bool, "suggested_location_id": str | None}
    for each sales channel, one entry per channel, order preserved.
    """
    plans = []
    for sc in sales_channels:
        needs_link = len(sc.get("stock_locations") or []) == 0
        suggested_location_id = None
        if needs_link:
            if default_location_id:
                suggested_location_id = default_location_id
            elif len(available_locations) == 1:
                suggested_location_id = available_locations[0]["id"]
        plans.append({
            "sales_channel_id": sc["id"],
            "sales_channel_name": sc.get("name"),
            "needs_link": needs_link,
            "suggested_location_id": suggested_location_id,
        })
    return plans


def link_stock_location(token, stock_location_id, sales_channel_id):
    r = requests.post(
        f"{BACKEND_URL}/admin/stock-locations/{stock_location_id}/sales-channels",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"add": [sales_channel_id], "remove": []},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def confirm_linked(token, sales_channel_id, stock_location_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/sales-channels/{sales_channel_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*stock_locations"},
        timeout=30,
    )
    r.raise_for_status()
    linked_ids = {loc["id"] for loc in r.json()["sales_channel"]["stock_locations"]}
    return stock_location_id in linked_ids


def run():
    token = get_admin_token()
    sales_channels = get_sales_channels(token)
    available_locations = get_stock_locations(token)

    plans = plan_stock_location_links(sales_channels, available_locations, STOCK_LOCATION_ID_OVERRIDE)

    linked = 0
    flagged = 0
    for plan in plans:
        if not plan["needs_link"]:
            log.info("Sales channel %s (%s): already linked to a stock location", plan["sales_channel_id"], plan["sales_channel_name"])
            continue

        if not plan["suggested_location_id"]:
            log.info("Sales channel %s (%s): flagged, no stock location linked and no unambiguous default to link", plan["sales_channel_id"], plan["sales_channel_name"])
            flagged += 1
            continue

        loc_id = plan["suggested_location_id"]
        log.info(
            "%s sales channel %s to stock location %s",
            "Would link" if DRY_RUN else "Linking", plan["sales_channel_id"], loc_id,
        )
        if not DRY_RUN:
            link_stock_location(token, loc_id, plan["sales_channel_id"])
            if not confirm_linked(token, plan["sales_channel_id"], loc_id):
                raise RuntimeError(f"Link did not take effect for sales channel {plan['sales_channel_id']}")
            log.info("Confirmed. Sales channel %s is now linked to stock location %s.", plan["sales_channel_id"], loc_id)
        linked += 1

    log.info("Done. %d sales channel(s) %s, %d sales channel(s) flagged for review.", linked, "to link" if DRY_RUN else "linked", flagged)


if __name__ == "__main__":
    run()
