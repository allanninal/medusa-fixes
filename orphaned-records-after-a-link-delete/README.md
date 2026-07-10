# Orphaned records after a link delete

Medusa v2 module link tables, such as `product_sales_channel` or
`product_variant_inventory_item`, have no database-level foreign key between
the two sides, because each module must stay isolated and independently
restorable. `Link.dismiss()` and the underlying `LinkModule` delete only
soft-delete the link row by setting `deleted_at`, and a true cascade only
fires for links explicitly configured that way. So when one side, a product,
sales channel, or inventory item, is hard-deleted directly through its own
module service instead of through the linking workflow, the link row is left
behind pointing at an id that no longer resolves.

This script lists candidate products with sales channels expanded,
cross-checks every id against its owning module's own retrieve route, and
reports every confirmed orphan. It only reports by default. Hard-deleting a
confirmed orphan link row must run from inside a Medusa server context that
can resolve the container and the specific link module, so that call is
documented in the script and the guide, not executed by an external process.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/orphaned-records-after-a-link-delete/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python orphaned-records-after-a-link-delete/python/find_orphaned_link_rows.py
node   orphaned-records-after-a-link-delete/node/find-orphaned-link-rows.js
```

`classify_link_orphan` is a pure decision function: it takes a link row
(only its `deleted_at` field matters) and two booleans for whether the left
and right side still exist, and returns one of `HEALTHY`, `ORPHAN_LEFT`,
`ORPHAN_RIGHT`, `ORPHAN_BOTH`, or `ALREADY_DELETED`. All the existence
checks happen in the caller through the Admin API, so the function itself
needs no network and no Medusa backend. Only a confirmed orphan verdict is
ever a candidate for a hard delete, and hard-deleting a link row is never
undoable, so start with `DRY_RUN=true` to only report.

## Test

```bash
pytest orphaned-records-after-a-link-delete/python
node --test orphaned-records-after-a-link-delete/node
```
