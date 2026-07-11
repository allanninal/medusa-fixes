# continueOnPermanentFailure skips compensation and leaves partial state

`.config({ continueOnPermanentFailure: true })` opts a Medusa v2 workflow step out of the saga's rollback contract. Per Medusa's own docs, the compensation function of the flagged step will not be called, so the workflow keeps running subsequent steps as if nothing happened. If that step already committed a side effect, an order, a captured payment, or a reservation, and a later step then fails and triggers a rollback, the orchestrator still does not retroactively undo the flagged step's work. This reconciler lists recent orders through the Admin API, classifies each one with a pure function, and reports every orphan as a structured record for a human to triage. The only guarded write is deleting a dangling reservation that has no live order line.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/continue-on-failure-skips-compensation/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SINCE_HOURS="24"
export DRY_RUN="true"

python continue-on-failure-skips-compensation/python/reconcile_skipped_compensation.py
node   continue-on-failure-skips-compensation/node/reconcile-skipped-compensation.js
```

`classify_orphan` / `classifyOrphan` is a pure function: given an order snapshot and the workflow's reported failed-step list, it decides whether the combination of `payment_status`, `fulfillment_status`, `payments`, `fulfillments`, and a `continueOnPermanentFailure`-flagged failed step implies uncompensated partial state, returning `orphaned_payment_no_fulfillment`, `orphaned_reservation_no_order_line`, or `ok`. Only `orphaned_reservation_no_order_line` is ever cleaned up automatically; everything else is reported for a human. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest continue-on-failure-skips-compensation/python
node --test continue-on-failure-skips-compensation/node
```
