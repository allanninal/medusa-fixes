"""Detect Medusa link table rows orphaned by a module or model rename.

Medusa v2's Module Links system derives a link table's name deterministically
from the linked modules' and data models' table names, for example
product_product_blog_post. When a developer renames a custom module (such as
blog to article) or a linked data model, defineLink produces a new,
differently named link definition. Medusa has no way to know this is a rename
rather than delete the old link and add a new one. Running
`npx medusa db:sync-links`, or `db:migrate`, which calls it internally, then
prompts to drop the old link table and create an empty new one, silently
orphaning every existing row unless the developer passes a third defineLink
config argument with database: { table: "<old_table_name>" } to pin the table
name across the rename.

This script reads the link tables Medusa currently generates (captured from
`npx medusa db:migrate --dry-run` into defined_links.json) and a table and
row-count report a companion step exposed over the Admin API, classifies every
leftover table with a pure function, and reports every table that looks
orphaned along with its likely rename source. It only reports by default. The
ALTER TABLE RENAME TO bridge and the config patch are documented in the guide,
reviewed by a human, and only ever run with an explicit --apply flag.

Guide: https://www.allanninal.dev/medusa/link-table-orphaned-on-rename/
"""
import json
import logging
import os
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("classify_link_rename")

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


def load_defined_link_tables(path="defined_links.json"):
    # Produced from `npx medusa db:migrate --dry-run` output, run inside the
    # Medusa project. Expected shape: ["product_product_article_post", ...]
    with open(path) as f:
        return json.load(f)


def load_db_table_report(token):
    # Exposed by a companion admin route or a medusa exec script that queried
    # information_schema.tables plus a count(*) per candidate table.
    # Expected shape: {"table_name": row_count, ...}
    r = requests.get(
        f"{BASE}/admin/link-table-report",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["row_counts"]


def _shared_segments(a, b):
    return set(a.split("_")) & set(b.split("_"))


def classify_link_rename(defined_link_tables, existing_db_tables, row_counts):
    """Pure decision logic, no I/O.

    For each table in existing_db_tables not present in defined_link_tables
    (a link table Medusa no longer generates from current defineLink calls),
    mark it orphaned if it has rows. Use shared name segments split on "_" to
    guess which current link it was likely renamed from, otherwise None.
    """
    results = []
    for table in existing_db_tables:
        if table in defined_link_tables:
            continue
        if row_counts.get(table, 0) <= 0:
            continue
        suspected = None
        best_overlap = 0
        for candidate in defined_link_tables:
            overlap = len(_shared_segments(table, candidate))
            if overlap > best_overlap:
                best_overlap = overlap
                suspected = candidate
        results.append({
            "orphaned_table": table,
            "row_count": row_counts[table],
            "suspected_rename_of": suspected,
        })
    return results


def run():
    token = login()
    defined_link_tables = load_defined_link_tables()
    row_counts = load_db_table_report(token)
    existing_db_tables = list(row_counts.keys())

    orphans = classify_link_rename(defined_link_tables, existing_db_tables, row_counts)
    for orphan in orphans:
        log.warning(
            "Table %s has %d row(s), no longer defined. Suspected rename of: %s. %s",
            orphan["orphaned_table"], orphan["row_count"],
            orphan["suspected_rename_of"] or "unknown",
            "would report" if DRY_RUN else "confirmed, patch defineLink or restore from backup",
        )
    log.info("Done. %d orphaned link table(s) found.", len(orphans))


if __name__ == "__main__":
    run()
