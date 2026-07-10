"""Find orphaned Medusa v2 module link rows left behind by a direct hard delete.

Module link tables such as product_sales_channel have no database-level
foreign key, since modules must stay isolated and independently restorable.
Link.dismiss() and LinkModule delete only soft-delete the link row itself,
and a true cascade only fires for links explicitly configured that way. So
if a product or sales channel is hard-deleted directly through its own
module service, the link row survives, pointing at an id that no longer
resolves. This script lists candidate products with sales channels expanded,
cross-checks every id against its owning module's own retrieve route, and
reports every confirmed orphan. It only reports by default. Hard-deleting a
confirmed orphan link row must run from inside a Medusa server context that
can resolve the container and the specific link module, so that part is
documented in the guide, not executed by this script.

Guide: https://www.allanninal.dev/medusa/orphaned-records-after-a-link-delete/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_orphaned_link_rows")

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


def list_products_with_sales_channels(token):
    r = requests.get(
        f"{BASE}/admin/products",
        params={"fields": "id,title,*sales_channels", "limit": 1000},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["products"]


def entity_exists(token, admin_path):
    r = requests.get(
        f"{BASE}{admin_path}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code == 404:
        return False
    r.raise_for_status()
    return True


def product_exists(token, product_id):
    return entity_exists(token, f"/admin/products/{product_id}")


def sales_channel_exists(token, sales_channel_id):
    return entity_exists(token, f"/admin/sales-channels/{sales_channel_id}")


def classify_link_orphan(link_row, left_exists, right_exists):
    """Pure decision table: no I/O, only booleans and primitives in.

    Returns one of: HEALTHY, ORPHAN_LEFT, ORPHAN_RIGHT, ORPHAN_BOTH, ALREADY_DELETED.
    """
    if link_row.get("deleted_at") is not None:
        return "ALREADY_DELETED"
    if not left_exists and not right_exists:
        return "ORPHAN_BOTH"
    if not left_exists:
        return "ORPHAN_LEFT"
    if not right_exists:
        return "ORPHAN_RIGHT"
    return "HEALTHY"


def hard_delete_confirmed_orphans(container, orphaned_sales_channel_ids, dry_run):
    """Reference only: only meaningful inside a Medusa server context where the
    container can resolve the link module. Never call this against ids that
    still resolve on both sides; sever a live link with link.dismiss() or
    dismissRemoteLinkStep instead so both modules stay in sync.
    """
    from medusa.container import ContainerRegistrationKeys, Modules  # pragma: no cover

    link = container.resolve(ContainerRegistrationKeys.LINK)
    link_module = link.get_link_module(
        Modules.PRODUCT, "sales_channel_id",
        Modules.SALES_CHANNEL, "sales_channel_id",
    )
    if not dry_run:
        link_module.delete({"sales_channel_id": orphaned_sales_channel_ids})


def run():
    token = login()
    orphan_count = 0
    for product in list_products_with_sales_channels(token):
        product_id = product.get("id")
        left_exists = product_exists(token, product_id)
        for sales_channel in product.get("sales_channels") or []:
            sales_channel_id = sales_channel.get("id")
            right_exists = sales_channel_id is not None and sales_channel_exists(token, sales_channel_id)
            link_row = {"deleted_at": None}
            verdict = classify_link_orphan(link_row, left_exists, right_exists)
            if verdict in ("ORPHAN_LEFT", "ORPHAN_RIGHT", "ORPHAN_BOTH"):
                orphan_count += 1
                log.warning(
                    "Orphan link (%s): product %s <-> sales_channel %s. %s",
                    verdict, product_id, sales_channel_id,
                    "would hard-delete" if DRY_RUN else "confirmed for hard delete",
                )
    log.info(
        "Done. %d orphan link row(s) %s.",
        orphan_count,
        "found" if DRY_RUN else "found (hard delete runs server-side)",
    )


if __name__ == "__main__":
    run()
