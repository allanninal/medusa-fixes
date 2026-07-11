# Scheduled jobs run sporadically on Redis backed deploys

A Medusa v2 scheduled job in `src/jobs` works every time locally, but on a split
server and worker deploy (Railway and similar) it fails every so often with a
`Workflow with id "<job-id>" not found` error sitting in Redis. This is because
`@medusajs/workflow-engine-redis` used one shared BullMQ queue for both workflow
transactions and scheduled jobs before PR #11740, so a `server`-mode instance,
which never registers job or workflow definitions, can still dequeue a
scheduled-job entry and fail. A related cause (issue #14889) is a hanging step
blocking the single default BullMQ worker.

Medusa exposes no Admin API for the workflow or job queue, so this script
connects directly to the same Redis instance with ioredis and bullmq, reads
the job queue across the `failed`, `active`, `delayed`, and `waiting` states,
and classifies each job with a pure function. It only reports by default. An
opt-in `DRY_RUN=false` cleanup removes entries that are genuinely orphaned
(`orphaned-not-found` or `exhausted-retries`); it never re-runs a workflow.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/scheduled-jobs-sporadic-redis-deploy/

## Run it

```bash
export REDIS_URL="redis://localhost:6379"
export JOB_QUEUE_NAME="medusa-job-queue"
export STEP_TIMEOUT_MS="60000"
export DRY_RUN="true"

python scheduled-jobs-sporadic-redis-deploy/python/classify_stuck_jobs.py
node   scheduled-jobs-sporadic-redis-deploy/node/classify-stuck-jobs.js
```

`classify_job` / `classifyJob` is a pure function (the current time and step
timeout are passed in): given a job's timestamps, `attemptsMade`, `opts`, and
`failedReason`, it returns `healthy`, `stuck-active`, `orphaned-not-found`,
`exhausted-retries`, or `pending-too-long`. The script only removes a job from
Redis when it is classified `orphaned-not-found` or `exhausted-retries` and
`DRY_RUN` is explicitly `false`. Everything else is left alone and reported so
an operator can confirm before manually re-invoking the workflow.

## Test

```bash
pip install -r python/requirements.txt 2>/dev/null; pytest scheduled-jobs-sporadic-redis-deploy/python
node --test scheduled-jobs-sporadic-redis-deploy/node
```

The tests import only the pure classifier function, so they need no Redis
connection and no network access.
