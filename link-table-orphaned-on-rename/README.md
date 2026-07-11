# Link table orphaned on rename

Medusa v2's Module Links system derives a link table's name deterministically from the linked modules' and data models' table names, for example `product_product_blog_post`. Renaming a custom module (such as `blog` to `article`) or a linked data model makes `defineLink` produce a new, differently named link definition. Medusa has no way to know this is a rename rather than delete the old link and add a new one, so `npx medusa db:sync-links` (or `db:migrate`, which calls it internally) prompts to drop the old link table and create an empty new one, silently orphaning every existing row.

This script compares the link tables Medusa currently generates against what actually exists in Postgres, flags any leftover table that still has rows, and reports it along with a guess at which current link it was likely renamed from. It only reports by default.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/link-table-orphaned-on-rename/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

# 1. Inside your Medusa project, capture the link tables Medusa currently
#    expects (no writes to the database):
npx medusa db:migrate --dry-run
# Save the resulting table names to defined_links.json, e.g.
#   ["product_product_article_post", "product_sales_channel", ...]

# 2. Run the reconciler
python link-table-orphaned-on-rename/python/classify_link_rename.py
node   link-table-orphaned-on-rename/node/classify-link-rename.js
```

`classify_link_rename` is a pure function (all I/O already happened before it runs): a table is flagged as orphaned only when it exists in Postgres, is not in the current `defineLink` output, and still has rows. It also guesses the likely rename source by comparing shared name segments split on `_`. The only output is a report, never a write. Start with `DRY_RUN=true` to review the list first.

If a table is confirmed orphaned:
- If the drop has not happened yet, add a third `defineLink` argument, `{ database: { table: "<old_table_name>" } }`, to pin the table name before the next `db:sync-links` run.
- If the drop already happened, restore the table from a pre-migration backup, or have a DBA run `ALTER TABLE ... RENAME TO` to bridge the old table to the name Medusa currently expects, then rerun `db:sync-links`. Neither of these runs automatically from this script.

## Test

```bash
pytest link-table-orphaned-on-rename/python
node --test link-table-orphaned-on-rename/node
```
