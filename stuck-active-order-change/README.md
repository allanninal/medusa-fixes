# Order edit blocked by a stuck active order change record

Medusa v2 enforces a single-active-order-change invariant per order. `getActiveOrderChange_()` looks for any `OrderChange` with status `pending` or `requested`, and every edit, return, claim, and exchange workflow calls `throwIfOrderChangeIsNotActive` before it will proceed. If a prior workflow crashed, timed out, or hit a compensation bug before the change reached a terminal status (`confirmed_at`, `declined_at`, or `canceled_at` set), that row is left behind and silently blocks every future attempt on the order, even though nothing appears to be in progress in the Admin UI.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/stuck-active-order-change/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STALE_HOURS="2"
export DRY_RUN="true"

python stuck-active-order-change/python/reconcile_stuck_order_change.py
node   stuck-active-order-change/node/reconcile-stuck-order-change.js
```

`classify_order_change` is a pure function (the current time is passed in): a change is `terminal` the moment any of `confirmed_at`, `declined_at`, or `canceled_at` is set, or its status is anything other than `pending` or `requested`. Otherwise it is `active_fresh` while still within `STALE_HOURS` of its last update, and only becomes `active_stale_stuck` once it has gone quiet past that window. The script only ever reports and, when `DRY_RUN=false`, cancels changes classified `active_stale_stuck`.

There is no public cancel-order-change Admin REST endpoint in Medusa v2. The actual cancellation must run inside a Medusa exec/run() context, resolving the Order module directly and calling `cancel(orderChangeId)`, which sets `canceled_at` and moves the row to a terminal status without altering the order's totals or line items. The script logs every candidate id and only performs the write when explicitly enabled, so start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest stuck-active-order-change/python
node --test stuck-active-order-change/node
```
