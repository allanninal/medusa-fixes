"""Find custom module link rows left dangling by a product delete that did not cascade.

Medusa v2 module links live in a pivot table outside both linked modules' own
schemas, by design, to keep modules isolated. Cascade on delete is opt-in via
deleteCascade in the defineLink call, and even then it is only honored when the
deletion runs through Medusa's own Link/Remote Link APIs or workflow steps, such
as deleteProductsWorkflow, removeRemoteLinkStep, or link.delete. A raw module
service delete or a direct SQL delete on the product bypasses that cascade
entirely, leaving rows in the custom link table pointing at a prod_ id that no
longer exists. This script lists every live product id, lists every product_id
your custom link table currently stores, diffs the two sets with a pure function,
and cross-checks each candidate with a 404 lookup before reporting it. It only
reports by default. Hard-deleting or soft-deleting a confirmed dangling row must
run from inside a Medusa server context that can resolve your custom module's
own service, so that part is documented in the guide, not executed by this script.

Guide: https://www.allanninal.dev/medusa/custom-link-no-cascade-delete/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_dangling_links")

BASE = os.environ["MEDUSA_BACKEND_URL"]
EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"


def login():
    r = requests.post(
        f"{BASE}/auth/user/emailpass",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def list_live_product_ids(token):
    ids, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE}/admin/products",
            params={"fields": "id", "limit": limit, "offset": offset},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        ids.extend(p["id"] for p in body["products"])
        offset += limit
        if offset >= body["count"]:
            return ids


def list_custom_link_rows(token):
    r = requests.get(
        f"{BASE}/admin/custom-entities",
        params={"fields": "id,product_id", "limit": 1000},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["custom_entities"]


def product_is_gone(token, product_id):
    r = requests.get(
        f"{BASE}/admin/products/{product_id}",
        params={"with_deleted": "true"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    return r.status_code == 404


def find_dangling_links(live_product_ids, link_rows):
    """Pure decision function: a link row is dangling iff its product_id
    is not a member of the current live-product id set.

    live_product_ids: a set (or set-like) of live 'prod_...' ids.
    link_rows: an iterable of {"id": ..., "product_id": ...} dicts.
    Returns: the subset of link_rows whose product_id is not live.
    """
    return [row for row in link_rows if row["product_id"] not in live_product_ids]


def run():
    token = login()
    live_ids = set(list_live_product_ids(token))
    link_rows = list_custom_link_rows(token)
    candidates = find_dangling_links(live_ids, link_rows)

    confirmed = 0
    for row in candidates:
        if not product_is_gone(token, row["product_id"]):
            continue
        confirmed += 1
        log.warning(
            "Dangling link row %s -> product %s. %s",
            row["id"], row["product_id"],
            "would report" if DRY_RUN else "confirmed, repair runs server-side",
        )
    log.info("Done. %d dangling link row(s) confirmed out of %d candidate(s).", confirmed, len(candidates))


if __name__ == "__main__":
    run()
