# Scheduled job did not run

Medusa v2 only registers and ticks the workflow behind a scheduled job
(a file in `src/jobs` exporting a handler and a cron `schedule`) on
instances running in `worker` or `shared` `MEDUSA_WORKER_MODE`. A
`server`-mode-only instance boots clean and answers every request
correctly, but never registers the job, so it silently never fires,
with no error anywhere. Separately, the default in-memory Workflow
Engine and Event Bus modules do not persist scheduling or execution
state across restarts or multiple instances, so a tick that was due
right at deploy or crash time is simply dropped. Medusa keeps no
job-run ledger and no `/admin/scheduled-jobs` history endpoint, and it
has no backfill or catch-up logic, so a missed tick is gone forever
unless the job's own downstream data is used to detect the gap.

This never replays a cron tick generically. It lists the domain
records the job maintains (for example `/admin/price-lists`, reading
`ends_at` and `updated_at`), computes the expected next run from the
job's own cron schedule using each record's last-run timestamp as the
anchor, and flags any record where the gap between now and that
expected run exceeds one full interval times a grace multiplier.
Repair only re-invokes the one specific workflow the job would have
run, once per flagged record, guarded by `DRY_RUN`, then writes a
`last_synced_at` marker so the same gap is never reprocessed twice.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/scheduled-job-did-not-run/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export JOB_CRON="0 * * * *"
export GRACE_MULTIPLIER="1.5"
export DRY_RUN="true"

python scheduled-job-did-not-run/python/find_missed_runs.py
node   scheduled-job-did-not-run/node/find-missed-runs.js
```

`find_missed_runs` (Python) / `findMissedRuns` (Node) is a pure
decision function: given the fetched records as plain `{ id,
lastRunAt }` values, the job's cron expression, the current time, and
a grace multiplier, it works out the average tick interval, computes
the run that should have fired right after each record's own last run,
and flags any record whose gap past that expected run exceeds the
interval times the grace multiplier. A record with no `lastRunAt` at
all is always flagged. It takes no I/O, uses no external cron library,
just a small dependency-free cron parser bundled in the same file, so
it is fully unit-testable without a running Medusa instance or a
network call. The only writes in the guarded repair path are a single
re-invocation of the specific workflow per flagged record and a
`last_synced_at` metadata marker, both skipped entirely while
`DRY_RUN=true`.

## Test

```bash
pytest scheduled-job-did-not-run/python
node --test scheduled-job-did-not-run/node
```
