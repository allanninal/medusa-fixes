"""Find Medusa publishable keys with zero active sales-channel links and link them, safely.

A publishable key only scopes /store/* requests through a link to one or more sales
channels. If that link is missing, or every linked channel is disabled, the key
resolves to zero sales channels and the storefront sees no products. This lists
every publishable key, decides what to do with a pure function, and only writes
when a target sales channel is explicit or there is exactly one unambiguous
default channel. Every other case is reported only. Run once, or on a schedule.
Safe to run again and again.

Guide: https://www.allanninal.dev/medusa/publishable-key-not-linked-to-a-sales-channel/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("link_publishable_key")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
SALES_CHANNEL_ID_OVERRIDE = os.environ.get("SALES_CHANNEL_ID", "").strip() or None


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_publishable_keys(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        params={"type": "publishable", "fields": "id,token,title,revoked_at,*sales_channels"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["api_keys"]


def get_enabled_sales_channels(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/sales-channels",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,name,is_disabled"},
        timeout=30,
    )
    r.raise_for_status()
    channels = r.json()["sales_channels"]
    return [c for c in channels if not c.get("is_disabled")]


def decide_api_key_repair(api_key, default_sales_channel_id):
    """Pure decision function. No I/O.

    api_key: {"id": str, "revoked_at": str | None, "sales_channels": [{"id": str, "is_disabled": bool}, ...]}
    default_sales_channel_id: str | None

    Returns {"action": "none" | "flag" | "link", "reason": str, "sales_channel_id_to_add"?: str}.
    """
    if api_key.get("revoked_at"):
        return {"action": "none", "reason": "key revoked"}

    active_links = [sc for sc in api_key.get("sales_channels") or [] if not sc.get("is_disabled")]
    if len(active_links) > 0:
        return {"action": "none", "reason": "already linked to an active sales channel"}

    if default_sales_channel_id is None:
        return {"action": "flag", "reason": "no sales channel linked and no unambiguous default to link"}

    return {
        "action": "link",
        "reason": "key has zero active sales-channel links",
        "sales_channel_id_to_add": default_sales_channel_id,
    }


def link_sales_channel(token, api_key_id, sales_channel_id):
    r = requests.post(
        f"{BACKEND_URL}/admin/api-keys/{api_key_id}/sales-channels",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"add": [sales_channel_id]},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def confirm_linked(token, api_key_id, sales_channel_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/api-keys/{api_key_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,*sales_channels"},
        timeout=30,
    )
    r.raise_for_status()
    linked_ids = {sc["id"] for sc in r.json()["api_key"]["sales_channels"]}
    return sales_channel_id in linked_ids


def default_sales_channel_id(token):
    if SALES_CHANNEL_ID_OVERRIDE:
        return SALES_CHANNEL_ID_OVERRIDE
    enabled = get_enabled_sales_channels(token)
    if len(enabled) == 1:
        return enabled[0]["id"]
    return None


def run():
    token = get_admin_token()
    keys = get_publishable_keys(token)
    default_sc_id = default_sales_channel_id(token)

    linked = 0
    flagged = 0
    for api_key in keys:
        decision = decide_api_key_repair(api_key, default_sc_id)
        log.info("Key %s (%s): action=%s reason=%s", api_key["id"], api_key.get("title"), decision["action"], decision["reason"])

        if decision["action"] == "flag":
            flagged += 1
            continue
        if decision["action"] != "link":
            continue

        sc_id = decision["sales_channel_id_to_add"]
        log.info(
            "%s api key %s to sales channel %s",
            "Would link" if DRY_RUN else "Linking", api_key["id"], sc_id,
        )
        if not DRY_RUN:
            link_sales_channel(token, api_key["id"], sc_id)
            if not confirm_linked(token, api_key["id"], sc_id):
                raise RuntimeError(f"Link did not take effect for key {api_key['id']}")
            log.info("Confirmed. Key %s is now linked to sales channel %s.", api_key["id"], sc_id)
        linked += 1

    log.info("Done. %d key(s) %s, %d key(s) flagged for review.", linked, "to link" if DRY_RUN else "linked", flagged)


if __name__ == "__main__":
    run()
