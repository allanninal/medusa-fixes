# Oversold variant goes negative

An inventory level's available quantity is `stocked_quantity` minus `reserved_quantity`, and that check runs inside the reserve-inventory workflow step. Under concurrent checkout traffic, retried webhooks, or a direct external write to stock levels, the read then write on that level is not always serialized, so `reserved_quantity` can end up higher than `stocked_quantity`. Medusa has no non-negative constraint on `stocked_quantity`, so the row just persists that way until someone corrects it. This script finds every oversold location level (skipping variants with `allow_backorder` on, since that is expected there), cross-checks against live reservations, and only recommends a recount, a human-approved `--confirm` is required before it writes anything.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/oversold-variant-goes-negative/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python oversold-variant-goes-negative/python/repair_oversold_inventory.py
node   oversold-variant-goes-negative/node/repair-oversold-inventory.js
```

`decide_inventory_repair` (Python) / `decideInventoryRepair` (Node) is a pure function: it computes `available = stockedQuantity - reservedQuantity`, flags a level as oversold only when `available < 0` or `reservedQuantity > stockedQuantity` and `allowBackorder` is false, and when flagged proposes `max(stockedQuantity, openReservationsTotal)` as the recount so the fix never drops below what open orders have already reserved. The script only logs this recommendation. It writes `POST /admin/inventory-items/{id}/location-levels/{location_id}` only when `DRY_RUN=false` and the process is run with `--confirm`, because an arbitrary `stocked_quantity` can mask a real fulfillment problem.

## Test

```bash
pytest oversold-variant-goes-negative/python
node --test oversold-variant-goes-negative/node
```
