# New payment collection ignores amounts already captured

When an order edit or order-change workflow raises the price on a Medusa v2 order and a new payment collection is needed, `createOrderPaymentCollectionWorkflow` builds the collection's amount from the order's current total instead of `order.summary.pending_difference`. It never nets out what the order's existing `payment_collections` and `transactions` already show as captured, so a partially paid order that gets a price bump ends up with a new collection demanding the full new total instead of just the outstanding balance.

This script lists candidate orders, recomputes the real outstanding amount with a pure decision function, and flags every order where an open payment collection is over-sized relative to `pending_difference` while a prior capture exists. It is report-only by default. Under an explicit `DRY_RUN=false`, it repairs only the unambiguous case: exactly one open collection, a prior capture, and something genuinely owed.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/new-collection-ignores-prior-capture/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python new-collection-ignores-prior-capture/python/reconcile_new_collection.py
node   new-collection-ignores-prior-capture/node/reconcile-new-collection.js
```

`reconcile_outstanding_amount` is a pure function: it takes the order's summary numbers and its open payment collections and returns an action of `none`, `flag`, or `recreate`, plus the correctly reconciled amount and the stale collection ids. It only recommends `recreate` when exactly one open collection exists and a prior capture is on file; anything with more than one open collection is `flag` only, for a human. Start with `DRY_RUN=true` to review the flagged list before any collection gets canceled and recreated.

## Test

```bash
pytest new-collection-ignores-prior-capture/python
node --test new-collection-ignores-prior-capture/node
```
