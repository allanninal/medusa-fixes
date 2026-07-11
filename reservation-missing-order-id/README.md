# Reservation records have no order id to trace back to

Medusa v2 deliberately decouples the Inventory module from the Order module. A
reservation, `ReservationItem`, stores only a bare `line_item_id` string, not a
real relation, and there is no module link between `ReservationItem` and the
Order module, so the Admin API and dashboard can never show which order a
reservation is for. This job lists reservations and orders, builds a line item
to order lookup that stands in for the Order module's own `OrderItem` join, and
reports every reservation as traced, orphaned, or not order backed. The only
write is optional enrichment: stamping the resolved order id into a traced
reservation's own metadata.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/reservation-missing-order-id/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export REPORT_PATH="reservation_trace_report.csv"
export DRY_RUN="true"

python reservation-missing-order-id/python/trace_reservation_orders.py
node   reservation-missing-order-id/node/trace-reservation-orders.js
```

`trace_reservations_to_orders` is a pure function (reservations and orders are
both passed in as plain arrays): a reservation is `traced` when its
`line_item_id` matches an item id in some order's `items[]`, `no_line_item`
when the reservation never had a `line_item_id` at all, and
`orphaned_line_item` when the `line_item_id` is set but does not match any
fetched order, either a stale reservation or an order outside the page
fetched. A CSV report is always written. The only mutating call is
`POST /admin/reservations/{id}` with `{metadata: {resolved_order_id}}`, gated
by `DRY_RUN`, and it only ever fires for reservations classified `traced`.
Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest reservation-missing-order-id/python
node --test reservation-missing-order-id/node
```
