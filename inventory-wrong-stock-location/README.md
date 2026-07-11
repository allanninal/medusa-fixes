# Inventory decremented at the wrong stock location

A stock location's availability for a sale is supposed to be scoped by the sales channel the order was placed through, using the `SalesChannelLocation` link between the Stock Location and Sales Channel modules. A bug tracked as [medusajs/medusa#10658](https://github.com/medusajs/medusa/issues/10658) meant the cart completion and order edit workflows could collect every stock location tied to an inventory item without filtering by the order's own sales channel, so a reservation could land at a location that belongs to a different channel entirely. This script walks recent orders, resolves the expected location for each reservation with a pure function, and reports every mismatch. It never rewrites a reservation on its own.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/inventory-wrong-stock-location/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export ORDER_LIMIT="50"
export DRY_RUN="true"

python inventory-wrong-stock-location/python/find_wrong_stock_location.py
node   inventory-wrong-stock-location/node/find-wrong-stock-location.js
```

`pick_expected_location_id` is a pure function: it filters an inventory item's location levels down to the ones linked to the order's sales channel, picks the first match as the expected location, and compares it to the reservation's actual `location_id`. The script only reports what it finds. Orders whose items are already fulfilled or shipped are always flagged for a manual stock adjustment rather than corrected automatically. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest inventory-wrong-stock-location/python
node --test inventory-wrong-stock-location/node
```
