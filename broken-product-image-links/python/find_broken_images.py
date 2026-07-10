"""Find and safely repair broken Medusa v2 product image links.

Medusa stores thumbnail and each images[].url as a plain string and never
re-validates it at read time. A redeploy with the Local File Module Provider,
an ephemeral container restart, a domain change, or a file provider migration
all leave old URLs pointing at nothing. This script paginates every product,
checks every unique image URL with a HEAD request, classifies each one with a
pure function, and only ever clears a confirmed-broken field. It never
guesses a replacement URL. Run on a schedule or by hand. Safe to run again
and again.

Guide: https://www.allanninal.dev/medusa/broken-product-image-links/
"""
import os
import logging
import requests
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_broken_images")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
CONFIGURED_IMAGE_HOSTS = [
    h.strip() for h in os.environ.get("CONFIGURED_IMAGE_HOSTS", "localhost:9000").split(",") if h.strip()
]


def classify_image_health(check):
    """Pure decision function. No I/O.

    check: {"url": str, "status": int | None, "error": str | None,
            "configured_hosts": list[str]}
    Returns {"state": "ok" | "unreachable" | "foreign_host" | "malformed", "reason": str}.

    1. A URL that does not parse as absolute is malformed.
    2. A network error, missing status, or a 4xx/5xx status is unreachable.
    3. A host that is not in configured_hosts is foreign_host, even if it
       happened to answer, since that is a strong signal of a stale
       provider URL or a pre-migration bucket.
    4. Otherwise the URL is ok.
    """
    url = check.get("url") or ""
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return {"state": "malformed", "reason": "not a valid absolute URL"}

    status = check.get("status")
    error = check.get("error")
    if error or status is None or status >= 400:
        return {"state": "unreachable", "reason": f"status {status if status is not None else 'network_error'}"}

    host = parsed.hostname or ""
    configured = [h.lower() for h in (check.get("configured_hosts") or [])]
    if host.lower() not in configured:
        return {
            "state": "foreign_host",
            "reason": "points at a non-current storage host (likely stale provider/migration)",
        }

    return {"state": "ok", "reason": "resolves on a currently configured host"}


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_products_with_images(token):
    limit = 100
    offset = 0
    while True:
        r = requests.get(
            f"{BACKEND_URL}/admin/products",
            headers={"Authorization": f"Bearer {token}"},
            params={"limit": limit, "offset": offset, "fields": "id,title,thumbnail,*images"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        for product in body["products"]:
            yield product
        offset += limit
        if offset >= body["count"]:
            return


def image_entries(product):
    entries = []
    if product.get("thumbnail"):
        entries.append({"field": "thumbnail", "url": product["thumbnail"]})
    for i, image in enumerate(product.get("images") or []):
        if image.get("url"):
            entries.append({"field": f"images[{i}].url", "url": image["url"]})
    return entries


def check_url(url, timeout=10):
    try:
        r = requests.head(url, timeout=timeout, allow_redirects=True)
        if r.status_code == 405:
            r = requests.get(url, timeout=timeout, headers={"Range": "bytes=0-0"}, stream=True)
        return {"status": r.status_code, "error": None}
    except requests.RequestException as exc:
        return {"status": None, "error": str(exc)}


def clear_broken_field(token, product, field, url, dry_run):
    if field == "thumbnail":
        body = {"thumbnail": None}
    else:
        body = {"images": [img for img in (product.get("images") or []) if img.get("url") != url]}

    log.info("%s product %s field %s", "Would clear" if dry_run else "Clearing", product["id"], field)
    if dry_run:
        return None
    r = requests.post(
        f"{BACKEND_URL}/admin/products/{product['id']}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def run():
    token = get_admin_token()
    checked_urls = {}
    broken = 0

    for product in list_products_with_images(token):
        for entry in image_entries(product):
            url = entry["url"]
            if url not in checked_urls:
                checked_urls[url] = check_url(url)
            result = checked_urls[url]

            verdict = classify_image_health({
                "url": url,
                "status": result["status"],
                "error": result["error"],
                "configured_hosts": CONFIGURED_IMAGE_HOSTS,
            })

            if verdict["state"] == "ok":
                continue

            log.warning(
                "Product %s (%s) field %s state=%s reason=%s url=%s",
                product["id"], product["title"], entry["field"], verdict["state"], verdict["reason"], url,
            )
            clear_broken_field(token, product, entry["field"], url, DRY_RUN)
            broken += 1

    log.info("Done. %d broken image entr%s %s.", broken, "y" if broken == 1 else "ies",
              "to clear" if DRY_RUN else "cleared")


if __name__ == "__main__":
    run()
