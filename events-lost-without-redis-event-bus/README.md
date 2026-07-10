# Events lost without the Redis event bus

Medusa v2's default Event Module, `event-bus-local`, is backed by Node's
`EventEmitter` and lives entirely inside a single process's memory. In any
multi-process deployment, rolling deploys, autoscaled workers, or a separate
API and worker container, an event emitted by one process is never seen by a
subscriber running in another, and anything emitted during a deploy or
restart window is dropped outright because nothing persists it. Side effects
like order confirmation emails, inventory sync, or fulfillment notifications
can silently never fire, and even with `@medusajs/event-bus-redis` and
`@medusajs/workflow-engine-redis` configured, subscriber registration races
and missing BullMQ retention settings can still lose events.

This never replays a raw event and never fabricates a historical
notification. It lists recent orders, lists the notifications the
Notification Module actually recorded for each one (`/admin/notifications`,
which persists every delivery attempt regardless of which Event Module
emitted the trigger), and flags any order past a grace window with zero
notification rows for the expected `event_name`, such as `order.placed`.
Repair only re-triggers the specific confirmation action, guarded by
`DRY_RUN` and a per-order idempotency check.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/events-lost-without-redis-event-bus/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export EXPECTED_EVENT="order.placed"
export GRACE_MINUTES="10"
export DRY_RUN="true"

python events-lost-without-redis-event-bus/python/find_missing_notifications.py
node   events-lost-without-redis-event-bus/node/find-missing-notifications.js
```

`find_orders_missing_notification` (Python) / `findOrdersMissingNotification`
(Node) is a pure decision function: given the fetched orders, the fetched
notifications, the expected event name, a grace period in milliseconds, and
the current time in epoch milliseconds, it builds a set of order ids that
already have a notification with `resource_type === "order"` and a matching
`event_name`, then flags every order older than the grace period that is not
in that set. It takes no I/O, so it is fully unit-testable without a running
Medusa instance. The only write in the guarded repair path is a re-trigger of
the specific confirmation action, and it is skipped per-order if a matching
notification already exists by the time the repair runs. Start with
`DRY_RUN=true` to review the full flagged list before writing anything.

## Test

```bash
pytest events-lost-without-redis-event-bus/python
node --test events-lost-without-redis-event-bus/node
```
