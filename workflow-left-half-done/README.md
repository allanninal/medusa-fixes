# Workflow left half done

Medusa v2 workflows are sagas: each step's rollback is opt-in through a compensation function passed to `createStep`, so a step without one, such as `createRemoteLinkStep`, leaves its side effect in place if a later step throws. Separately, a crashed process or the in-memory Workflow Engine used in production means the saga never reaches the compensating phase at all, so an already-committed reservation from `reserveInventoryStep` stays committed while `workflow_execution` is stuck in a non-terminal state. This job lists reservations, resolves each `line_item_id`'s parent order, classifies each reservation with a pure function, and deletes only the unambiguous orphan cases: an order that no longer resolves (404) or an order whose status is `canceled`. Everything else is reported only.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/workflow-left-half-done/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STALE_MINUTES="10"
export DRY_RUN="true"

python workflow-left-half-done/python/reconcile_half_run_workflows.py
node   workflow-left-half-done/node/reconcile-half-run-workflows.js
```

`classify_reservation` is a pure function (the resolved order and the current time are passed in): a reservation is only ever eligible for delete when it is `orphaned_no_order` (its order no longer resolves) or `orphaned_canceled_order` (its order's status is `canceled`). A reservation with no `line_item_id`, one whose order is still `pending` or `completed`, or one younger than `STALE_MINUTES` is always `healthy`. Anything older than `STALE_MINUTES` whose order is in some other, non-terminal status is `stale_pending_review`, and the script only reports it, it never deletes it. The only write is `DELETE /admin/reservations/{id}`, run one reservation at a time with its id logged before the delete. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest workflow-left-half-done/python
node --test workflow-left-half-done/node
```
