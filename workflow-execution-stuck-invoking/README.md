# Workflow executions stuck in invoking state

A long running Medusa v2 workflow's `workflow_execution` row is meant to move through `invoking` to `done`, `failed`, or `compensating` as its async steps complete. When an async step never gets its external completion signal, a webhook that never calls `setStepSuccess`, a worker that crashed mid step, or a subscriber that never fired, that row is left mid invoke, and without an explicit `retentionTime` there is no built in TTL sweep to expire it. This script lists rows still in `invoking`, flags the ones stuck past an expected TTL, and reports the transaction ids for an operator to retry safely. It never writes to `workflow_execution` directly.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/workflow-execution-stuck-invoking/

## Run it

There is no public `/admin/workflow-executions` REST route in Medusa v2, so this connects read only to Postgres, the same table the Admin UI's Settings, Workflows view reads server side.

```bash
export MEDUSA_DATABASE_URL="postgres://user:pass@localhost:5432/medusa"
export DEFAULT_TTL_MINUTES="20"
export DRY_RUN="true"

python workflow-execution-stuck-invoking/python/flag_stuck_invoking.py
node   workflow-execution-stuck-invoking/node/flag-stuck-invoking.js
```

`is_stuck_invoking` is a pure function (the current time is passed in): a row is flagged only when its state is still `invoking` and the time since it was last updated (falling back to when it was created) is past the TTL for that workflow id. This script only ever reports. The actual repair, retrying the specific stalled step with the Workflow Engine Module's `retryStep`, or cancelling the transaction through the workflow's own compensation logic, is left to an operator, since a raw delete or update on `workflow_execution` risks orphaning an in-flight compensation or double-triggering a side effect like a payment capture.

## Test

```bash
pip install pytest
pytest workflow-execution-stuck-invoking/python

node --test workflow-execution-stuck-invoking/node
```

The tests import only the pure functions (`is_stuck_invoking` / `isStuckInvoking`, `detect_flapping` / `detectFlapping`), so they run with no database connection and no installed driver.
