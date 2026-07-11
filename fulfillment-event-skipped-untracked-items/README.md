# Fulfillment created event skipped for untracked items

`createOrderFulfillmentWorkflow` runs `emitEventStep` for
`order.fulfillment_created` near the end of its step graph, after the
inventory reservation steps that only touch line items whose variant has
`manage_inventory: true` (tracked in
[medusajs/medusa#10721](https://github.com/medusajs/medusa/issues/10721)).
When every item on a fulfillment is untracked inventory, those reservation
steps have nothing to operate on, and the workflow can finish before it
reaches `emitEventStep`. The fulfillment record is still created correctly,
only the event, and anything that depended on it like a shipment-notification
email, is skipped silently.

This script lists recent orders with their fulfillments and item inventory
flags, decides with one pure function whether a fulfillment's event was
likely missed, cross-checks the notification log to confirm, and reports
every confirmed miss.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/fulfillment-event-skipped-untracked-items/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python fulfillment-event-skipped-untracked-items/python/find_missed_fulfillment_events.py
node   fulfillment-event-skipped-untracked-items/node/find-missed-fulfillment-events.js
```

`is_fulfillment_event_likely_missed` is a pure function: it takes a
fulfillment, a map from `line_item_id` to its `manage_inventory` flag, and the
set of fulfillment ids that already have a matching notification, and returns
true only when every item on the fulfillment resolves to untracked (a missing
lookup defaults to untracked, conservative) and no notification exists yet. A
mixed fulfillment, some tracked and some not, is left alone.

This is not safely auto-fixable by replaying `createOrderFulfillmentWorkflow`,
since that would create a duplicate fulfillment. With `DRY_RUN=false` the
script logs the pair to re-emit and calls `mark_backfilled` /
`markBackfilled`, which patches the fulfillment's metadata so the same one is
never re-emitted twice. The actual re-emit of `order.fulfillment_created`
has to run inside the Medusa process itself, since only there can
`Modules.EVENT_BUS` be resolved, for example from a Medusa `exec` script:

```js
// src/scripts/backfill-exec.js
import { Modules } from "@medusajs/framework/utils";

export default async function backfillMissedFulfillmentEvent({ container }, fulfillmentId, orderId) {
  const eventBusModuleService = container.resolve(Modules.EVENT_BUS);
  await eventBusModuleService.emit({
    name: "order.fulfillment_created",
    data: { fulfillment_id: fulfillmentId, order_id: orderId },
  });
}
```

Start with `DRY_RUN=true` to only report the affected `order_id` /
`fulfillment_id` pairs.

## Test

```bash
pytest fulfillment-event-skipped-untracked-items/python
node --test fulfillment-event-skipped-untracked-items/node
```
