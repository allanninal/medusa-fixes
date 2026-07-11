# CSV import ignores the variant inventory quantity column

In Medusa v2, stock lives on a `location_levels` record under a linked `inventory_item`, in the `stocked_quantity` field, not on the variant itself. `importProductsWorkflow` creates the inventory item for each variant, but its CSV normalization step does not map the legacy `Variant Inventory Quantity` column to a location level creation step, tracked upstream as [medusajs/medusa#11605](https://github.com/medusajs/medusa/issues/11605) and [#9357](https://github.com/medusajs/medusa/issues/9357). Every imported variant can end up with no location level, or one stuck at zero, no matter what quantity the source CSV actually had.

This job reads back the variants an import batch created, compares each one's real location levels against the source CSV row for its SKU, and either logs or writes the missing `stocked_quantity`.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/csv-import-ignores-inventory-quantity/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export IMPORT_BATCH_TAG="import-2026-07-10"
export IMPORT_CSV_PATH="import.csv"
export DEFAULT_LOCATION_ID="sloc_..."
export DRY_RUN="true"

python csv-import-ignores-inventory-quantity/python/repair_import_inventory.py
node   csv-import-ignores-inventory-quantity/node/repair-import-inventory.js
```

`decide_inventory_repair` (Python) / `decideInventoryRepair` (Node) is a pure function: given a CSV row, a variant, its actual location levels, and the default stock location id, it returns the repair action to take, or nothing if the CSV expected no stock, the variant has no inventory item, or the stock already matches. The only writes are creating or updating a location level, so it never fulfills, prices, or otherwise edits a product. Start with `DRY_RUN=true` to review the list of intended changes first, and confirm `DEFAULT_LOCATION_ID` yourself since picking the right stock location is store specific.

## Test

```bash
pytest csv-import-ignores-inventory-quantity/python
node --test csv-import-ignores-inventory-quantity/node
```
