# Redis event bus drops or delays subscriber execution

Medusa v2's default Redis Event Bus Module queues emitted domain events, such as `order.placed` from the complete cart workflow, as BullMQ jobs for a worker process to consume. If the instance that owns the subscriber registration starts after the event was already published, restarts mid-job, autoscales, or crashes without a matching retry and dead-letter configuration, the job can be picked up with no subscriber attached, retried past its attempt limit, or dropped depending on queue options. This reconciler pulls orders and notifications for a window and classifies every order as delivered, delayed, or dropped by diffing against the Notification module's own delivery log.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/redis-event-bus-drops-events/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export WINDOW_HOURS="24"
export DELAY_THRESHOLD_MS="60000"
export DRY_RUN="true"

python redis-event-bus-drops-events/python/reconcile_event_delivery.py
node   redis-event-bus-drops-events/node/reconcile-event-delivery.js
```

`diff_event_delivery` is a pure function: for each order it finds the earliest matching `order.placed` notification recorded by the Notification module. No match means `dropped`. A match past `delay_threshold_ms` means `delayed`. Otherwise the order is `delivered`. The script never mutates an order or a notification record directly, since there is no safe idempotent resend API for arbitrary past events. `DRY_RUN=true` only writes audit records for confirmed drops.

Re-emitting a dropped event through the workflow engine is a manual, opt-in step. Set `DRY_RUN=false` and list the order_id values a human has explicitly confirmed in `CONFIRMED_REEMIT_IDS` (comma separated). Only those orders are re-emitted, one at a time, through a small custom workflow that calls `emitEventStep({ eventName: "order.placed", data: { id: order.id } })` from `@medusajs/medusa/core-flows`. This re-triggers every subscriber attached to `order.placed`, including customer emails, so it must never run unattended.

## Test

```bash
pytest redis-event-bus-drops-events/python
node --test redis-event-bus-drops-events/node
```
