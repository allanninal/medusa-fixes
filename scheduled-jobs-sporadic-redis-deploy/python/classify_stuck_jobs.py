"""Classify Medusa v2 scheduled job entries sitting in the Redis backed
BullMQ job queue, because a server-mode instance dequeued a job from a
shared queue before PR #11740 and threw Workflow with id not found, or
a hanging step stalled the single default BullMQ worker (issue #14889).

DRY_RUN=true only reports the classified jobs. Only removes entries
classified as genuinely orphaned (orphaned-not-found or
exhausted-retries), never re-runs a workflow.

Guide: https://www.allanninal.dev/medusa/scheduled-jobs-sporadic-redis-deploy/
"""
import os
import re
import json
import time
import logging


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("classify_stuck_jobs")

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
JOB_QUEUE_NAME = os.environ.get("JOB_QUEUE_NAME", "medusa-job-queue")
STEP_TIMEOUT_MS = int(os.environ.get("STEP_TIMEOUT_MS", "60000"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

STATES = ["failed", "active", "delayed", "waiting"]
NOT_FOUND_RE = re.compile(r"Workflow with id .* not found")
REMOVABLE = {"orphaned-not-found", "exhausted-retries"}


def get_redis_client():
    import redis
    return redis.Redis.from_url(REDIS_URL, decode_responses=True)


def queue_key(suffix):
    # BullMQ's own key convention: bull:<queueName>:<suffix>
    return f"bull:{JOB_QUEUE_NAME}:{suffix}"


def fetch_jobs(client):
    """Read BullMQ job hashes directly from Redis for every relevant state."""
    jobs = []
    for state in STATES:
        job_ids = client.zrange(queue_key(state), 0, -1) if state == "delayed" \
            else client.lrange(queue_key(state), 0, -1)
        for job_id in job_ids:
            data = client.hgetall(queue_key(job_id))
            if not data:
                continue
            opts = json.loads(data.get("opts", "{}"))
            jobs.append({
                "redis_key": queue_key(job_id),
                "id": data.get("name", job_id),
                "timestamp": int(data.get("timestamp", 0)),
                "processedOn": int(data["processedOn"]) if data.get("processedOn") else None,
                "finishedOn": int(data["finishedOn"]) if data.get("finishedOn") else None,
                "failedReason": data.get("failedReason"),
                "attemptsMade": int(data.get("attemptsMade", 0)),
                "opts": opts,
            })
    return jobs


def classify_job(job, now, step_timeout_ms):
    """Pure: no I/O. job is a dict already read from Redis/BullMQ.

    Returns one of: 'healthy', 'stuck-active', 'orphaned-not-found',
    'exhausted-retries', 'pending-too-long'.
    """
    failed_reason = job.get("failedReason")
    if failed_reason and NOT_FOUND_RE.search(failed_reason):
        return "orphaned-not-found"

    processed_on = job.get("processedOn")
    finished_on = job.get("finishedOn")
    if processed_on is not None and finished_on is None and (now - processed_on) > step_timeout_ms:
        return "stuck-active"

    attempts_made = job.get("attemptsMade", 0)
    attempts_allowed = (job.get("opts") or {}).get("attempts") or 1
    if finished_on is None and attempts_made >= attempts_allowed and failed_reason:
        return "exhausted-retries"

    timestamp = job.get("timestamp")
    if processed_on is None and timestamp is not None and (now - timestamp) > step_timeout_ms:
        return "pending-too-long"

    return "healthy"


def remove_job(client, redis_key):
    """Delete the BullMQ job hash for a genuinely orphaned entry. Never call
    this on stuck-active or pending-too-long jobs, since removing those
    hides a hang instead of fixing it."""
    client.delete(redis_key)


def run():
    client = get_redis_client()
    now = int(time.time() * 1000)
    jobs = fetch_jobs(client)

    flagged = []
    for job in jobs:
        classification = classify_job(job, now, STEP_TIMEOUT_MS)
        if classification == "healthy":
            continue
        flagged.append((job, classification))
        log.warning(
            "Job %s classified %s. failedReason=%s attemptsMade=%s/%s",
            job["id"], classification, job.get("failedReason"),
            job.get("attemptsMade"), (job.get("opts") or {}).get("attempts"),
        )

    if not flagged:
        log.info("No stuck or orphaned jobs across %d entr(y/ies).", len(jobs))
        return

    if not DRY_RUN:
        for job, classification in flagged:
            if classification in REMOVABLE:
                log.info("Removing orphaned job %s (%s).", job["id"], classification)
                remove_job(client, job["redis_key"])

    log.info("Done. %d job(s) %s.", len(flagged), "to review" if DRY_RUN else "processed")


if __name__ == "__main__":
    run()
