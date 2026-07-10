"""Find Medusa publishable API keys that match no products and repair the safe case.

In Medusa v2, every /store/* request is scoped by the x-publishable-api-key header,
and that key's scope is defined entirely by which sales channels are linked to it.
A key with zero linked sales channels is valid but matches no products, so
/store/products silently returns an empty array instead of erroring. This lists
every publishable key, classifies it with a pure decision function, and for the
"no_sales_channels" case, links it to the default sales channel. Every other
classification (revoked, channels_disabled, channels_empty) is reported only,
never auto-fixed. Run once, or on a schedule. Safe to run again and again.
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fix_publishable_key_sales_channel")

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


def admin_get(token, path, params=None):
    r = requests.get(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def admin_post(token, path, body):
    r = requests.post(
        f"{BACKEND_URL}{path}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def decide_publishable_key_fix(key, product_count_by_sales_channel):
    """Pure decision function. No I/O.

    key: {"id": str, "revoked_at": str | None, "sales_channels": [{"id": str, "is_disabled": bool}, ...]}
    product_count_by_sales_channel: {sales_channel_id: count}

    Returns {"status": str, "action": str}.
    """
    if key.get("revoked_at"):
        return {"status": "revoked", "action": "flag"}

    channels = key.get("sales_channels") or []
    if len(channels) == 0:
        return {"status": "no_sales_channels", "action": "link_default_channel"}

    if all(ch.get("is_disabled") is True for ch in channels):
        return {"status": "channels_disabled", "action": "flag"}

    if all(product_count_by_sales_channel.get(ch["id"], 0) == 0 for ch in channels):
        return {"status": "channels_empty", "action": "flag"}

    return {"status": "ok", "action": "none"}


def list_publishable_keys(token):
    keys = []
    offset = 0
    limit = 100
    while True:
        data = admin_get(
            token,
            "/admin/api-keys",
            {
                "type": "publishable",
                "limit": limit,
                "offset": offset,
                "fields": "id,title,token,redacted,revoked_at,*sales_channels",
            },
        )
        keys.extend(data["api_keys"])
        offset += limit
        if offset >= data["count"]:
            return keys


def product_count_for_sales_channel(token, sales_channel_id):
    data = admin_get(
        token,
        "/admin/products",
        {"sales_channel_id[]": sales_channel_id, "limit": 1, "fields": "id"},
    )
    return data["count"]


def default_sales_channel_id(token):
    if SALES_CHANNEL_ID_OVERRIDE:
        return SALES_CHANNEL_ID_OVERRIDE
    data = admin_get(token, "/admin/sales-channels", {"name": "Default Sales Channel", "limit": 1})
    channels = data["sales_channels"]
    if not channels:
        raise RuntimeError("No 'Default Sales Channel' found. Pass SALES_CHANNEL_ID explicitly.")
    return channels[0]["id"]


def link_default_sales_channel(token, key_id, sales_channel_id):
    return admin_post(
        token,
        f"/admin/api-keys/{key_id}/sales-channels",
        {"add": [{"id": sales_channel_id}]},
    )


def run():
    token = get_admin_token()
    keys = list_publishable_keys(token)

    product_count_by_sales_channel = {}
    for key in keys:
        for ch in key.get("sales_channels") or []:
            if ch["id"] not in product_count_by_sales_channel:
                product_count_by_sales_channel[ch["id"]] = product_count_for_sales_channel(token, ch["id"])

    fixed = 0
    for key in keys:
        decision = decide_publishable_key_fix(key, product_count_by_sales_channel)
        log.info("Key %s (%s): status=%s action=%s", key["id"], key.get("title"), decision["status"], decision["action"])

        if decision["action"] != "link_default_channel":
            continue

        sc_id = default_sales_channel_id(token)
        log.info(
            "Key %s has no sales channels. %s POST /admin/api-keys/%s/sales-channels {\"add\": [{\"id\": \"%s\"}]}",
            key["id"], "Would call" if DRY_RUN else "Calling", key["id"], sc_id,
        )
        if not DRY_RUN:
            link_default_sales_channel(token, key["id"], sc_id)
            after = admin_get(token, f"/admin/api-keys/{key['id']}", {"fields": "id,*sales_channels"})
            log.info("Confirmed. Key %s now has %d linked sales channel(s).", key["id"], len(after["api_key"]["sales_channels"]))
        fixed += 1

    log.info("Done. %d key(s) %s.", fixed, "to link" if DRY_RUN else "linked")


if __name__ == "__main__":
    run()
