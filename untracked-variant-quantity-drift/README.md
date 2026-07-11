# manage_inventory false variants still lose stock quantity

A variant with `manage_inventory` set to `false` is supposed to be always in stock, with the Inventory Module leaving its stock levels alone. In practice, several order and fulfillment workflow steps call `reserveQuantity` or `adjustInventory` style steps keyed off the `inventory_item` without re-checking the owning variant's `manage_inventory` flag first, so a level-decrement runs anyway when the untracked variant still has a linked inventory item and location level. This script pulls every variant with its `manage_inventory` flag and current location levels, keeps only the untracked ones that still have levels, and diffs each one against a baseline snapshot the script maintains between runs to flag any that changed. It never guesses a corrected quantity, since the true untracked stock level is unknowable once decremented. A restore write only happens when an operator passes an explicit baseline value with `DRY_RUN=false`.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/untracked-variant-quantity-drift/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"
export BASELINE_PATH="untracked_drift_baseline.json"

python untracked-variant-quantity-drift/python/detect_untracked_drift.py
node   untracked-variant-quantity-drift/node/detect-untracked-drift.js
```

`detect_untracked_quantity_drift` (Python) / `detectUntrackedQuantityDrift` (Node) is a pure function: it skips variants where `manageInventory` is true, skips variants with no linked `inventoryItemId` or empty `locationLevels`, and for every remaining untracked variant computes `delta = currentQuantity - baselineQuantity` per location, reporting a record only when `delta !== 0`, since any change at all on a supposedly untracked variant is suspect. The first run has no baseline yet, so nothing is flagged, it only seeds the snapshot file. To approve a specific restore, run with `DRY_RUN=false` and pass `--restore=VARIANT_ID=QTY` for each variant a human has confirmed the correct baseline for; the script logs the previous value before writing `POST /admin/inventory-items/{id}/location-levels/{location_id}`.

## Test

```bash
pytest untracked-variant-quantity-drift/python
node --test untracked-variant-quantity-drift/node
```
