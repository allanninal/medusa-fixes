# Scheduled job runs twice per configured interval

Medusa v2 scheduled jobs are registered and fired independently by every running process whose `workerMode` includes background processing, `shared` or `worker`. There is no distributed lock or single-leader coordination across instances, so running more than one such process against the same database, a duplicated worker deployment, or a container orchestrator scaling replicas without splitting `workerMode`, makes every tick fire once per process still doing background work.

This script detects the duplicate ticks through the Workflow Engine Module's own execution history. It lists workflow executions for the job, buckets them by the cron tick they belong to, and flags any bucket with more than one `transaction_id` for the same `workflow_id`. It only reports. It never resends a suppressed side effect and never deletes a `workflow_execution` row, since the actual fix belongs in `workerMode` configuration, not in the data.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/scheduled-job-runs-twice/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export JOB_WORKFLOW_ID="job-name"
export JOB_CRON="*/15 * * * *"
export DRY_RUN="true"

python scheduled-job-runs-twice/python/find_duplicate_ticks.py
node   scheduled-job-runs-twice/node/find-duplicate-ticks.js
```

`find_duplicate_ticks` is a pure function (execution rows and the cron schedule are passed in as data): a tick is flagged only when more than one distinct `transaction_id` lands within the bucket tolerance of the same cron tick boundary. Start with `DRY_RUN=true` to review the list first. The only write, even with `DRY_RUN=false`, is an audit log line per duplicate tick, never a resend, never a delete.

## Test

```bash
pytest scheduled-job-runs-twice/python
node --test scheduled-job-runs-twice/node
```
