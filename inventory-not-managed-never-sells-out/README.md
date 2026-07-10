# Inventory not managed, item never sells out

Every `ProductVariant` in Medusa v2 has a `manage_inventory` flag. When it is
not exactly `true`, the cart and checkout workflows skip the Inventory Module
entirely, so `stocked_quantity` and `reserved_quantity` never enter the
picture and the variant can be sold forever, no matter how much real stock is
left. This script lists every product's variants, classifies each one as
`ok`, `exempt`, `unmanaged_risk`, or `managed_but_untracked`, and reports every
variant that is a real oversell risk before it sells past zero.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/inventory-not-managed-never-sells-out/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python inventory-not-managed-never-sells-out/python/classify_inventory_risk.py
node   inventory-not-managed-never-sells-out/node/classify-inventory-risk.js
```

`classify_variant_inventory_risk` is a pure function: it takes a plain
variant record (manage_inventory, inventory_items, product_tags) and returns
one of four strings, with no I/O. Tags in the exempt list (digital, service,
gift-card by default) win first, then a flag that is not exactly `true` is an
`unmanaged_risk`, then a flag that is `true` but has no inventory item with a
positive stocked quantity anywhere is `managed_but_untracked`, and anything
else is `ok`. Flipping `manage_inventory` on and creating a location level is
a separate, human-approved write, since the script must never invent a
`stocked_quantity`. Start with `DRY_RUN=true` to only report.

## Test

```bash
pytest inventory-not-managed-never-sells-out/python
node --test inventory-not-managed-never-sells-out/node
```
