# Subscriber fails silently on order.placed

A subscriber in Medusa v2 is a plain async function registered against an
event name, and it runs detached from the workflow that emitted the event.
The order was already committed before order.placed ever fired, so a thrown
error, an unhandled promise rejection, or a container resolution failure
inside the subscriber has nowhere to report back to the order itself.
Nothing in the Admin, the order status, or the API response changes. The
side effect the subscriber was supposed to run, a confirmation email, a
warehouse sync, simply never happens, and nobody can point to an error that
explains why.

This never re-emits the raw event and never fabricates a historical
notification. It lists recent orders, lists the notifications the
Notification Module actually recorded for each one (`/admin/notifications`,
which persists every delivery attempt regardless of which subscriber
triggered it), and flags any order past a grace window with zero
notification rows for the expected `event_name`, such as `order.placed`.
Repair only re-triggers the specific confirmation action, guarded by
`DRY_RUN` and a per-order idempotency check.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/subscriber-fails-silently-on-order-placed/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export EXPECTED_EVENT="order.placed"
export GRACE_MINUTES="10"
export DRY_RUN="true"

python subscriber-fails-silently-on-order-placed/python/find_missing_notifications.py
node   subscriber-fails-silently-on-order-placed/node/find-missing-notifications.js
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
pytest subscriber-fails-silently-on-order-placed/python
node --test subscriber-fails-silently-on-order-placed/node
```
