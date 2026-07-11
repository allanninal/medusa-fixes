# Fulfillment sometimes leaves a stale inventory reservation

Medusa v2 creates a `ReservationItem` linking an `inventory_item_id`, `location_id`, and the order's `line_item_id` whenever a line item is purchased. The intended lifecycle deletes that row once the line item is fulfilled, but the delete step is not transactionally guaranteed. When a variant has multiple inventory items, or the fulfillment and order completion handlers race or partially fail, the reservation can survive an order that is already completed or canceled, silently shrinking available stock at that location forever. This reconciler lists closed orders, resolves the reservations tied to their line items, and deletes only the ones whose order status and fulfillment status are both terminal.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/stale-reservation-after-fulfillment/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python stale-reservation-after-fulfillment/python/find_stale_reservations.py
node   stale-reservation-after-fulfillment/node/find-stale-reservations.js
```

`find_stale_reservations` is a pure function (orders and reservations are passed in as plain data): it builds a map from `line_item_id` to the order that owns it, then keeps only the reservations whose order's `status` is `completed` or `canceled` AND whose `fulfillment_status` is `fulfilled`, `delivered`, or `canceled`. Everything still active, pending, or in progress is left alone. The only write is `DELETE /admin/reservations/{id}`, the same route the admin dashboard's Delete reservation action uses. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest stale-reservation-after-fulfillment/python
node --test stale-reservation-after-fulfillment/node
```
