# Order stuck not fulfilled past SLA

In Medusa v2, placing an order and fulfilling an order are decoupled. Capturing
a payment only updates `payment_status`. Nothing forces a fulfillment to be
created, so an order can sit with `fulfillment_status` `"not_fulfilled"` (or
`"partially_fulfilled"`) indefinitely if the automation that should create a
fulfillment, an `order.placed` subscriber, a scheduled job, or a warehouse
integration, silently fails. This is worse in production when the default
in-memory Event Bus and Workflow Engine modules are used instead of their
Redis-backed equivalents, because events and job runs do not persist across
process restarts or multiple instances.

The Admin API cannot filter orders server-side by `fulfillment_status` or
`payment_status`, so this pages through orders and computes the SLA breach
client-side. It never creates a fulfillment. Picking, packing, and shipping
are real-world actions this script cannot safely fabricate. It only patches
`metadata` to flag a breached order for human review, and only when
`DRY_RUN` is off.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/order-stuck-not-fulfilled-past-sla/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SLA_HOURS="48"
export DRY_RUN="true"

python order-stuck-not-fulfilled-past-sla/python/flag_sla_breached_orders.py
node   order-stuck-not-fulfilled-past-sla/node/flag-sla-breached-orders.js
```

`evaluate_order_sla` (Python) / `evaluateOrderSla` (Node) is a pure decision
function: given an order, the current time in epoch milliseconds, and the SLA
in hours, it computes `is_paid` from `payment_status` (or every
`payment_collections` entry being `"captured"`), `is_unfulfilled` from
`fulfillment_status` being `"not_fulfilled"` or `"partially_fulfilled"`, or an
empty `fulfillments` array, and `age_hours` from the order's age. It excludes
canceled orders and orders already carrying `metadata.sla_flagged`, and
returns `breached: true` only when the order is paid, unfulfilled, older than
the SLA, and not canceled or already flagged. The only write is a
`metadata` patch on the flagged order via `POST /admin/orders/{id}`, which
always spreads the existing `metadata` first since Medusa replaces the whole
object rather than deep-merging. Start with `DRY_RUN=true` to review the full
list before writing anything.

## Test

```bash
pytest order-stuck-not-fulfilled-past-sla/python
node --test order-stuck-not-fulfilled-past-sla/node
```
