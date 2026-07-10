"""Detect a Medusa module link whose pivot table was never synced, safely.

A module link created with defineLink() under src/links/ is backed by its own
pivot table, separate from each module's own migrations. That table is only
created or updated when db:sync-links runs, or as part of db:migrate. A
deploy that runs migrations but skips the link sync, or a link file added
after the last migrate, leaves the link defined in code but the table absent
or stale, so the expanded relation resolves empty for every record even
though the linked module independently has rows.

This script only reads. It lists parent records with the relation expanded,
independently confirms the linked module has data of its own, classifies the
result with a pure function, and reports the verdict. It never touches a
pivot table directly, because there is no admin route that can create one.
When it reports LIKELY_UNMIGRATED_LINK, the fix is to run
`npx medusa db:sync-links` or `npx medusa db:migrate` against the deployed
backend, then run this check again.

Guide: https://www.allanninal.dev/medusa/linked-data-missing-after-link-migration/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("detect_unmigrated_link")

BACKEND_URL = os.environ["MEDUSA_BACKEND_URL"]
ADMIN_EMAIL = os.environ["MEDUSA_ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["MEDUSA_ADMIN_PASSWORD"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
LINK_DEFINITION_EXISTS_IN_CODE = os.environ.get("LINK_DEFINITION_EXISTS_IN_CODE", "true").lower() == "true"


def get_admin_token():
    r = requests.post(
        f"{BACKEND_URL}/auth/user/emailpass",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["token"]


def get_products_with_brand(token):
    products = []
    offset = 0
    limit = 100
    while True:
        r = requests.get(
            f"{BACKEND_URL}/admin/products",
            headers={"Authorization": f"Bearer {token}"},
            params={"fields": "id,title,*brand", "limit": limit, "offset": offset},
            timeout=30,
        )
        r.raise_for_status()
        body = r.json()
        products.extend(body["products"])
        offset += limit
        if offset >= body["count"]:
            return products


def get_brands(token):
    r = requests.get(
        f"{BACKEND_URL}/admin/brands",
        headers={"Authorization": f"Bearer {token}"},
        params={"limit": 100},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["brands"]


def has_linked_field(product):
    brand = product.get("brand")
    if brand is None:
        return False
    if isinstance(brand, list):
        return len(brand) > 0
    return True


def count_linked_field_present(products):
    return sum(1 for p in products if has_linked_field(p))


def detect_unmigrated_link(total_parent_records, parents_with_linked_field_present,
                            linked_module_has_any_records, link_definition_exists_in_code):
    """Pure decision function. No I/O.

    total_parent_records: int
    parents_with_linked_field_present: int
    linked_module_has_any_records: bool
    link_definition_exists_in_code: bool

    Returns one of "OK", "NO_LINK_DEFINED", "LIKELY_UNMIGRATED_LINK", "LINK_NOT_YET_POPULATED".
    """
    if not link_definition_exists_in_code:
        return "NO_LINK_DEFINED"
    if total_parent_records == 0:
        return "OK"
    if parents_with_linked_field_present == 0 and linked_module_has_any_records:
        return "LIKELY_UNMIGRATED_LINK"
    if parents_with_linked_field_present == 0 and not linked_module_has_any_records:
        return "LINK_NOT_YET_POPULATED"
    return "OK"


def run():
    token = get_admin_token()
    products = get_products_with_brand(token)
    brands = get_brands(token)

    total = len(products)
    present = count_linked_field_present(products)
    linked_module_has_any_records = len(brands) > 0

    verdict = detect_unmigrated_link(total, present, linked_module_has_any_records, LINK_DEFINITION_EXISTS_IN_CODE)

    log.info("Checked %d product(s), %d with brand present, %d brand record(s) exist.", total, present, len(brands))
    log.info("Verdict: %s", verdict)

    if verdict == "LIKELY_UNMIGRATED_LINK":
        log.warning(
            "The brand relation is empty on every product even though brands exist. "
            "This looks like the pivot table behind the link was never synced. "
            "Run `npx medusa db:sync-links` or `npx medusa db:migrate` against the backend, "
            "then run this check again to confirm."
        )
    elif verdict == "LINK_NOT_YET_POPULATED":
        log.info("No brand records exist yet, so an empty relation is expected, not a migration bug.")
    elif verdict == "NO_LINK_DEFINED":
        log.info("LINK_DEFINITION_EXISTS_IN_CODE is false, so this check does not apply here.")
    else:
        log.info("Looks fine. At least one product resolved the brand relation.")

    return verdict


if __name__ == "__main__":
    run()
