# Existing reservation blocks fulfillment of its own order

Medusa v2 computes an inventory level's available quantity as `stocked_quantity` minus `reserved_quantity`, and the admin fulfillment checks gate on that number being above zero. They never subtract out the reservation belonging to the order being fulfilled, so once `reserved_quantity` reaches `stocked_quantity` on the last unit sold, the very order that holds the reservation is told there is zero available and fulfillment is blocked. This gets worse when reservations are orphaned, left behind after an order is canceled or archived, or after a fulfillment bug fails to delete them, since those stale rows permanently occupy the stock and cause the same deadlock for other, still open orders sharing that inventory item and location.

This job scans reservations, resolves each one's order, and deletes only the ones confirmed as orphans. Anything tied to an open, unfulfilled order is left alone, and if its level still shows `reserved_quantity` equal to `stocked_quantity`, the order is flagged for manual review instead of being auto-fixed.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/reservation-blocks-own-order-fulfillment/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python reservation-blocks-own-order-fulfillment/python/clear_blocking_reservations.py
node   reservation-blocks-own-order-fulfillment/node/clear-blocking-reservations.js
```

`classify_reservation` / `classifyReservation` is a pure function: it takes a reservation, the resolved order info, and the location's inventory levels, and returns `keep`, `manual_keep`, `orphan_missing_order`, `orphan_canceled_order`, or `orphan_already_fulfilled`. Only the three orphan outcomes are ever deleted. A reservation classified `keep` or `manual_keep` is never touched, and if it still shows `reserved_quantity` equal to `stocked_quantity`, the order is logged for manual review instead. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest reservation-blocks-own-order-fulfillment/python
node --test reservation-blocks-own-order-fulfillment/node
```
