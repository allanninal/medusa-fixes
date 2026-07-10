"""Find Medusa products that share a duplicate handle after an import, safely.

Medusa v2 auto-generates a product handle from its title whenever a create
payload omits one, but that default is applied per row inside the create or
batch product workflow. It never checks the rest of the store for a
collision, and the handle column has no enforced unique database constraint.
A CSV import with duplicate or blank titles, or one that gets re-run after a
partial failure, can therefore leave several products sharing one handle.

This lists every product, groups them by handle with a pure function, and
reports every group that has more than one member, including status and
variant SKUs, so a human can tell the real product from the import artifact.
The only write this script can make is renaming the newer duplicate's handle
to a disambiguated slug, and it only does that when DRY_RUN is explicitly set
to false. It never deletes a product. Run once, or on a schedule. Safe to run
again and again, since a resolved handle group simply stops appearing.

Guide: https://www.allanninal.dev/medusa/duplicate-product-handles-from-import/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_handles")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
AUTO_REPAIR = os.environ.get("AUTO_REPAIR", "false").lower() == "true"


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_all_products(token):
    products, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BACKEND_URL}/admin/products",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,handle,title,status,created_at", "limit": limit, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        products.extend(body["products"])
        offset += limit
        if offset >= body["count"]:
            return products


def get_product_detail(token, product_id):
    r = requests.get(
        f"{BACKEND_URL}/admin/products/{product_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"fields": "id,handle,title,status,*variants.sku,*sales_channels.id"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def find_duplicate_handles(products):
    """Pure function. No I/O.

    products: [{"id": str, "handle": str, "title": str, "created_at": str}, ...]

    Returns [{"handle": str, "products": [...]}, ...] for every handle shared
    by more than one product, with each group's members sorted by created_at
    ascending, oldest first (likely original), so callers can decide which
    entries are the extra import duplicates.
    """
    by_handle = {}
    for p in products:
        by_handle.setdefault(p.get("handle"), []).append(p)

    groups = []
    for handle, members in by_handle.items():
        if len(members) > 1:
            ordered = sorted(members, key=lambda p: p.get("created_at") or "")
            groups.append({"handle": handle, "products": ordered})
    return groups


def rename_handle(token, product_id, new_handle):
    r = requests.post(
        f"{BACKEND_URL}/admin/products/{product_id}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"handle": new_handle},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["product"]


def run():
    token = get_admin_token()
    products = list_all_products(token)
    groups = find_duplicate_handles(products)

    if not groups:
        log.info("Done. No duplicate product handles found across %d product(s).", len(products))
        return

    log.info("Found %d duplicate handle group(s).", len(groups))
    for group in groups:
        handle = group["handle"]
        log.info("Handle %r has %d products:", handle, len(group["products"]))
        for p in group["products"]:
            detail = get_product_detail(token, p["id"])
            skus = [v.get("sku") for v in (detail.get("variants") or [])]
            channels = [sc["id"] for sc in (detail.get("sales_channels") or [])]
            log.info(
                "  id=%s title=%r status=%s created_at=%s skus=%s sales_channels=%s",
                p["id"], p.get("title"), detail.get("status"), p.get("created_at"), skus, channels,
            )

        if not AUTO_REPAIR:
            continue

        oldest, *newer_duplicates = group["products"]
        for i, dup in enumerate(newer_duplicates, start=2):
            new_handle = f"{handle}-{i}"
            log.info(
                "%s product %s handle to %r",
                "Would rename" if DRY_RUN else "Renaming", dup["id"], new_handle,
            )
            if not DRY_RUN:
                rename_handle(token, dup["id"], new_handle)

    log.info("Done. %d duplicate handle group(s) reported.", len(groups))


if __name__ == "__main__":
    run()
