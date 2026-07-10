# Stuck reservations after cancelled carts

A cart reserves stock by creating a Medusa `ReservationItem` linked to a `line_item_id`, `inventory_item_id`, and `location_id`. There is no cart cancel workflow that reliably deletes that reservation, and `ReservationItem` has no `cart_id` field to join back to, so an abandoned, timed out, or manually voided cart leaves the row behind. This job lists reservations, resolves each `line_item_id` against real orders, and deletes only the ones that are a true orphan or tied to a canceled order, after an age gate so an in-flight checkout is never touched.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/stuck-reservations-after-cancelled-carts/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STALE_AFTER_HOURS="24"
export DRY_RUN="true"

python stuck-reservations-after-cancelled-carts/python/release_stuck_reservations.py
node   stuck-reservations-after-cancelled-carts/node/release-stuck-reservations.js
```

`classify_reservation` is a pure function (the order line item index and the current time are passed in): a reservation is only ever flagged `stale_orphan` or `stale_canceled_order` when it is older than `STALE_AFTER_HOURS` and its `line_item_id` either matches no order at all or matches an order whose status is `canceled`. Everything else, including any reservation still tied to an active order, is kept. The only write is `DELETE /admin/reservations/{id}`, and after a real delete the script re-fetches the inventory item's location level to confirm `reserved_quantity` actually dropped by the expected amount. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest stuck-reservations-after-cancelled-carts/python
node --test stuck-reservations-after-cancelled-carts/node
```
