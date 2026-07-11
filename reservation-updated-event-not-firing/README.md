# Reservation update event never fires

Medusa v2's `InventoryModuleService.updateReservationItem` emitted the wrong event constant (confirmed in [medusajs/medusa#11704](https://github.com/medusajs/medusa/issues/11704), fixed in [PR #11714](https://github.com/medusajs/medusa/pull/11714)): it fired `inventory-item.updated` instead of `reservation-item.updated` whenever a reservation's quantity, line item, or location changed, whether from the admin UI, the Admin API, or an internal workflow like order fulfillment or cancellation. A subscriber registered for `RESERVATION_ITEM_UPDATED` never receives that change, so a stock-sync integration built on it silently drifts.

This reconciler lists reservations per stock location, diffs their live quantity against a last-synced snapshot, and cross-checks each inventory item's `reserved_quantity` at every location level against the sum of live reservations there. By default it only reports drift, it never rewrites a Medusa reservation it does not own.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/reservation-updated-event-not-firing/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python reservation-updated-event-not-firing/python/reconcile_reservation_sync.py
node   reservation-updated-event-not-firing/node/reconcile-reservation-sync.js
```

`diff_reservation_sync` is a pure function: it takes the live reservations and a last-synced quantity map keyed by `res_...` id, and returns only the reservations whose quantity diverged, with the signed drift and how long they have been stale. `location_level_mismatches` is a second pure function that flags any inventory location level whose `reserved_quantity` no longer equals the sum of live reservations Medusa reports there.

By default the script only prints a report. Rerun with `DRY_RUN=false` and pass `--apply` to have it update its own last-synced baseline and forward the corrected delta to whatever external stock system your sync consumer feeds. It never calls `POST /admin/reservations/{id}` to re-save a reservation, since that will not retrigger the buggy emit path anyway.

## Test

```bash
pytest reservation-updated-event-not-firing/python
node --test reservation-updated-event-not-firing/node
```
