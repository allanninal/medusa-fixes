# Variant not purchasable, no inventory level

A Medusa v2 variant with `manage_inventory` set to true is only purchasable
when its inventory item has an `InventoryLevel` row at a stock location
linked to the sales channel making the request. If a bulk import, seed
script, or partial product-creation workflow skipped the step that creates
that level, the inventory item ends up with zero location levels, or with a
level only at a stock location never linked to the storefront's sales
channel. Either way the variant reads as permanently out of stock even
though it can still show active with a price in the admin. This script lists
every managed variant, reads its inventory item's existing levels, decides
what to do with a pure function, and only creates a level where one is fully
absent, always at `stocked_quantity` zero. A level that exists only at the
wrong location is flagged for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/variant-not-purchasable-no-inventory-level/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SALES_CHANNEL_ID="sc_..."   # the storefront's sales channel
export DRY_RUN="true"

python variant-not-purchasable-no-inventory-level/python/create_missing_levels.py
node   variant-not-purchasable-no-inventory-level/node/create-missing-levels.js
```

`decide_inventory_repair` / `decideInventoryRepair` is a pure function: an
untracked variant is skipped, a managed variant with no inventory item is
flagged rather than guessed at, and a managed variant is compared against
the required stock location ids to compute exactly which ones have no
level row at all. Only those missing locations become a repair action. The
only write is `POST /admin/inventory-items/{inventory_item_id}/location-levels`
with `stocked_quantity: 0`, and it only ever runs against a location that
had no level row, so an existing stock count is never overwritten. Start
with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest variant-not-purchasable-no-inventory-level/python
node --test variant-not-purchasable-no-inventory-level/node
```
