# Reserve inventory step fails even with backorders allowed

In Medusa v2, completing a cart runs `completeCartWorkflow`, which calls
`reserveInventoryStep` for each line item. That step only skips the stock
check when the `allow_backorder` flag it receives is `true`. A recurring bug
([medusajs/medusa#13892](https://github.com/medusajs/medusa/issues/13892)) is
that `allow_backorder` is not reliably threaded into the step for every code
path, so a variant configured to allow backorders is still evaluated as if
backorders were disallowed, and `InventoryModuleService.ensureInventoryLevels`
throws `Not enough stock available for item <iitem_id> at location <sloc_id>`
mid-workflow. Because the exception happens late inside the same
transactional workflow, `completeCartWorkflow` rolls back entirely, and the
cart is never marked completed or converted into an order.

This script lists backorder-enabled variants, flags location levels at or
below zero available stock, and, once the live variant is re-verified as
still allowing backorders, safely retries cart completion instead of writing
a reservation by hand.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/backorder-reservation-step-fails/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export DRY_RUN="true"

python backorder-reservation-step-fails/python/retry_backorder_reservation.py
node   backorder-reservation-step-fails/node/retry-backorder-reservation.js
```

`decide_reservation_action` (Python) / `decideReservationAction` (Node) is a
pure function: it takes a plain item record (`allow_backorder`,
`manage_inventory`, `stocked_quantity`, `reserved_quantity`,
`requested_quantity`, ids) and a `dry_run` flag, and returns an action with no
I/O.

- If inventory is not managed, `noop`, nothing to reserve.
- If available stock (`stocked_quantity - reserved_quantity`) covers the
  requested quantity, `noop`, the reservation should succeed on its own.
- If backorders are disabled and stock is short, `flag_legitimate_stockout`,
  the rejection is correct and the cart should stay stuck.
- If backorders are enabled and stock is short, `flag_legitimate_stockout`
  while `dry_run` is `true`, otherwise `retry_complete`.

The script never force-writes a reservation. When the decision is
`retry_complete`, it re-fetches the live variant with
`GET /admin/products/{id}/variants/{variant_id}` one more time, and only
calls `POST /store/carts/{cart_id}/complete` if `allow_backorder` and
`manage_inventory` are both still `true` and no reservation already exists.
That protects against acting on a stale snapshot. Start with `DRY_RUN=true`
to only report.

## Test

```bash
pytest backorder-reservation-step-fails/python
node --test backorder-reservation-step-fails/node
```
