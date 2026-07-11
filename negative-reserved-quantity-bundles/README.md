# Negative reserved quantity on multi-part bundles

A bundled or multi-part variant should reserve each component inventory item at its own `required_quantity`. When a variant is instead composed of a single inventory item with a `required_quantity` greater than one, the allocate-items workflow and the fulfillment workflow can disagree on that multiplier, so a location level's `reserved_quantity` is decremented by a different amount than it was incremented by, and the stored value drifts, typically negative. This script pages through multi-part variants, sums the live reservations for each affected inventory item and location, diffs that sum against the stored `reserved_quantity`, and by default only flags and reports the drift under `DRY_RUN`. Only with an operator's confirmation does it resync the stored value to the exact computed sum, one row at a time, skipping anything with an order or fulfillment still in flight.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/negative-reserved-quantity-bundles/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"
export CONFIRM_RESYNC="false"

python negative-reserved-quantity-bundles/python/resync_negative_reserved.py
node   negative-reserved-quantity-bundles/node/resync-negative-reserved.js
```

`compute_reserved_quantity_drift` (Python) / `computeReservedQuantityDrift` (Node) is a pure function: it sums `quantity` across the live reservations for an inventory item and location to get `computedReserved`, computes `drift` as the stored `reserved_quantity` minus `computedReserved`, flags `isNegativeAnomaly` when the stored value is below zero, and sets `needsResync` when either of those is true. The script only logs this recommendation by default. It writes `POST /admin/inventory-items/{id}/location-levels/{location_id}` with the computed sum only when `DRY_RUN=false` and `CONFIRM_RESYNC=true`, never zeroing the value or applying an arbitrary offset, and it skips any row where a reservation still looks tied to an order or fulfillment in flight.

## Test

```bash
pytest negative-reserved-quantity-bundles/python
node --test negative-reserved-quantity-bundles/node
```
