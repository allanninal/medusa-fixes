"""Classify Medusa link table rows left behind because there is no hard delete.

Medusa v2's Module Links deliberately expose only soft-delete style operations.
link.dismiss (and the dismissRemoteLinkStep workflow step) marks a link table
row with deleted_at rather than removing it, and link.delete only cascades when
the link definition is configured to. Medusa's core team confirmed on GitHub
(medusajs/medusa#13315) this is by design, not a bug, because a workflow step
must be reversible through compensation, and an irreversible hard delete of a
pivot row cannot be undone. When a linked entity is removed outside a workflow,
the matching link row is left behind, either live and pointing at a gone id, or
already soft-deleted, and no public API will ever purge either one.

This script reads the live ids on both sides of a known link pair over the
Admin API, reads the raw link rows a companion medusa exec script exposed
(since getLinkModule only resolves inside a Medusa server context), classifies
every row with a pure function, and reports every row that is not already fine.
It only reports by default. Hard-deleting a confirmed orphan must run from
inside Medusa through link.getLinkModule, so that part is documented in the
guide, not executed by this external script.

Guide: https://www.allanninal.dev/medusa/no-hard-delete-for-link-rows/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("classify_link_rows")

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


def list_live_ids(token, resource, key):
    ids, offset, limit = [], 0, 200
    while True:
        r = requests.get(
            f"{BASE}/admin/{resource}",
            params={"fields": "id", "limit": limit, "offset": offset},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        ids.extend(row["id"] for row in body[key])
        offset += limit
        if offset >= body["count"]:
            return ids


def list_link_rows(token):
    # Exposed by a companion medusa exec script that resolved
    # link.getLinkModule(...) and called linkModule.list({}, { withDeleted: true }).
    # Expected shape: [{"left_id": ..., "right_id": ..., "deleted_at": ... or None}, ...]
    r = requests.get(
        f"{BASE}/admin/link-rows",
        params={"pair": "product_sales_channel"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["rows"]


def classify_link_row(row, live_left_ids, live_right_ids):
    """Pure decision function. No I/O, takes precomputed id sets.

    - A soft-deleted row (deleted_at is not None) is always reportable,
      since no public API ever purges it, regardless of whether the
      parents still exist.
    - A live-looking row pointing at a missing parent is "orphan_dangling",
      the dangerous case since queries may still surface it.
    - Anything else is "ok".
    """
    if row.get("deleted_at") is not None:
        return "orphan_soft_deleted"
    if row["left_id"] not in live_left_ids or row["right_id"] not in live_right_ids:
        return "orphan_dangling"
    return "ok"


def run():
    token = login()
    live_left_ids = set(list_live_ids(token, "products", "products"))
    live_right_ids = set(list_live_ids(token, "sales-channels", "sales_channels"))
    rows = list_link_rows(token)

    reportable = 0
    for row in rows:
        status = classify_link_row(row, live_left_ids, live_right_ids)
        if status == "ok":
            continue
        reportable += 1
        log.warning(
            "Link row %s -> %s is %s. %s",
            row["left_id"], row["right_id"], status,
            "would report" if DRY_RUN else "confirmed, hard delete runs server-side",
        )
    log.info("Done. %d reportable row(s) out of %d total.", reportable, len(rows))


if __name__ == "__main__":
    run()
