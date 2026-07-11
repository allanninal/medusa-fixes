# Scheduled jobs stop firing after long uptime

Medusa v2's Redis workflow engine, `@medusajs/medusa/workflow-engine-redis`,
runs every scheduled job as a BullMQ job on one shared queue, and by
default `jobWorkerOptions.concurrency` is 1. If a scheduled job's
workflow step hangs, an unbounded stream read, an await on a promise
that never settles, or a stalled external call with no timeout, that
single execution never completes and never fails out. It occupies the
only worker slot forever, so every later cron tick for every scheduled
job on that queue is enqueued but never dequeued, and the whole
scheduler looks like it silently died after some uptime, matching
[medusajs/medusa issue #14889](https://github.com/medusajs/medusa/issues/14889).

There is no Admin API route that can kill a stuck BullMQ job or
restart the scheduler from outside the process, so this only detects
and flags the stall, it never tries to repair it. A lightweight
heartbeat scheduled job writes a `last_run_at` timestamp somewhere
readable over the Admin API (for example `metadata` on a dedicated
stock location). This script polls that timestamp, computes the
heartbeat job's expected interval from its own cron schedule, and
alerts an operator to restart the worker process once the gap exceeds
the interval times a tolerance multiplier.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/scheduled-jobs-stop-after-uptime/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export HEARTBEAT_STOCK_LOCATION_ID="sloc_heartbeat"
export HEARTBEAT_CRON="*/5 * * * *"
export TOLERANCE_MULTIPLIER="3"
export ALERT_WEBHOOK_URL=""
export DRY_RUN="true"

python scheduled-jobs-stop-after-uptime/python/check_scheduler_heartbeat.py
node   scheduled-jobs-stop-after-uptime/node/check-scheduler-heartbeat.js
```

`is_scheduler_stalled` (Python) / `isSchedulerStalled` (Node) is a
pure decision function: given the last heartbeat timestamp, the
current time, the heartbeat job's cron schedule, and a tolerance
multiplier, it works out the schedule's expected interval using a
small dependency-free cron parser bundled in the same file, and
returns true only when the gap since the last heartbeat exceeds that
interval times the tolerance. It takes no I/O, so it is fully
unit-testable with fixed clocks and fixture schedules, for example
`* * * * *` gives a 60,000ms interval, and a 20 minute gap with
tolerance 3 reads as stalled.

`DRY_RUN=true` only logs locally. `DRY_RUN=false` additionally posts
to `ALERT_WEBHOOK_URL` recommending an operator restart the worker
instance running `MEDUSA_WORKER_MODE=worker`. Nothing in this script
ever writes to Medusa or touches the stuck job or queue, because there
is no safe Admin API action that can do that from outside the process.
The durable fix is raising `jobWorkerOptions.concurrency` above 1 and
adding a step-level timeout to the workflow step that can hang.

## Test

```bash
pytest scheduled-jobs-stop-after-uptime/python
node --test scheduled-jobs-stop-after-uptime/node
```
