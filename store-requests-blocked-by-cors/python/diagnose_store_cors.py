"""Diagnose Medusa Store API requests blocked by CORS.

Medusa enforces CORS on /store/* routes via storeCors in medusa-config.ts,
backed by the STORE_CORS environment variable. There is no Admin API for this
setting, so this script never writes anything. It probes the live backend
with a real OPTIONS preflight for every configured storefront origin, checks
whether a valid publishable key is being rejected too (a separate 401 issue
that is often mistaken for CORS), and reports the exact origin string and
file to change. Only a human edits medusa-config.ts and redeploys.

Guide: https://www.allanninal.dev/medusa/store-requests-blocked-by-cors/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("diagnose_store_cors")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
STOREFRONT_ORIGINS = [
    o.strip() for o in os.environ.get(
        "STOREFRONT_ORIGINS", "http://localhost:8000"
    ).split(",") if o.strip()
]


def _normalize(origin):
    origin = origin.strip().rstrip("/")
    if "://" not in origin:
        return origin.lower()
    scheme, rest = origin.split("://", 1)
    return f"{scheme.lower()}://{rest.lower()}"


def diagnose_cors_gap(configured_origins, request_origin, has_valid_publishable_key):
    """Pure decision function. No I/O.

    configured_origins: list[str] of origins that already passed a live preflight
        check (i.e. Medusa currently answers with a matching Access-Control-Allow-Origin
        for them). Membership means "this exact origin already works."
    request_origin: str, the origin under test.
    has_valid_publishable_key: bool, result of a separate, unrelated check
        (GET /store/regions with x-publishable-api-key did not return 401).

    Returns {"verdict": "OK"|"CORS_MISMATCH"|"NOT_CORS_PAK_ISSUE"|"STALE_CONFIG", "reason": str}.
    """
    if not has_valid_publishable_key:
        return {
            "verdict": "NOT_CORS_PAK_ISSUE",
            "reason": "Request failed with 401, not a CORS rejection. Attach a valid x-publishable-api-key.",
        }

    normalized_request = _normalize(request_origin)
    normalized_configured = [_normalize(o) for o in configured_origins]

    if normalized_request in normalized_configured:
        return {
            "verdict": "OK",
            "reason": "Origin is already listed in STORE_CORS. If it still fails in the browser, "
                      "confirm the running backend process has been restarted since the env var "
                      "changed, otherwise treat it as STALE_CONFIG.",
        }

    same_host_entries = [
        o for o in normalized_configured
        if o.split("://")[-1].split(":")[0] == normalized_request.split("://")[-1].split(":")[0]
    ]
    if same_host_entries:
        closest = same_host_entries[0]
        req_scheme = normalized_request.split("://")[0]
        cfg_scheme = closest.split("://")[0]
        if req_scheme != cfg_scheme:
            reason = f"origin uses {req_scheme} but STORE_CORS only lists {cfg_scheme}://same-host"
        else:
            reason = f"origin port or path differs from the closest configured entry {closest}"
        return {"verdict": "CORS_MISMATCH", "reason": reason}

    return {
        "verdict": "CORS_MISMATCH",
        "reason": f"origin {normalized_request} has no matching host in STORE_CORS at all",
    }


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def first_publishable_key(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/api-keys",
        headers={"Authorization": f"Bearer {token}"},
        params={"type": "publishable", "limit": 1, "fields": "id,token,revoked_at"},
        timeout=30,
    )
    r.raise_for_status()
    keys = r.json()["api_keys"]
    return keys[0]["token"] if keys else None


def publishable_key_is_valid(backend_url, publishable_key):
    if not publishable_key:
        return False
    r = requests.get(
        f"{backend_url}/store/regions",
        headers={"x-publishable-api-key": publishable_key},
        timeout=15,
    )
    return r.status_code != 401


def preflight_allows_origin(backend_url, origin):
    r = requests.options(
        f"{backend_url}/store/regions",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        timeout=15,
    )
    allowed = r.headers.get("Access-Control-Allow-Origin")
    return allowed == origin or allowed == "*"


def run():
    token = get_admin_token()
    pak = first_publishable_key(token)
    pak_valid = publishable_key_is_valid(BACKEND_URL, pak)

    passing_origins = [o for o in STOREFRONT_ORIGINS if preflight_allows_origin(BACKEND_URL, o)]

    gaps = 0
    for origin in STOREFRONT_ORIGINS:
        result = diagnose_cors_gap(passing_origins, origin, pak_valid)
        log.info("Origin %s: verdict=%s reason=%s", origin, result["verdict"], result["reason"])
        if result["verdict"] == "CORS_MISMATCH":
            log.warning(
                "%s Add %s to STORE_CORS (and AUTH_CORS, per Medusa's docs) in medusa-config.ts "
                "or the STORE_CORS env var, then restart/redeploy the backend.",
                "Would report:" if DRY_RUN else "Report:", origin,
            )
            gaps += 1
        elif result["verdict"] == "NOT_CORS_PAK_ISSUE":
            log.warning(
                "%s Not a CORS defect. Attach a valid x-publishable-api-key tied to the storefront's "
                "sales channel. Verify via GET /admin/api-keys/{id} and "
                "/admin/api-keys/{id}/sales-channels.",
                "Would report:" if DRY_RUN else "Report:",
            )
            gaps += 1

    log.info("Done. %d origin(s) with a gap out of %d checked.", gaps, len(STOREFRONT_ORIGINS))


if __name__ == "__main__":
    run()
