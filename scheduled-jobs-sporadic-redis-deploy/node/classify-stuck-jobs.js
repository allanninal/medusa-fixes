/**
 * Classify Medusa v2 scheduled job entries sitting in the Redis backed
 * BullMQ job queue, because a server-mode instance dequeued a job from a
 * shared queue before PR #11740 and threw Workflow with id not found, or
 * a hanging step stalled the single default BullMQ worker (issue #14889).
 *
 * DRY_RUN=true only reports the classified jobs. Only removes entries
 * classified as genuinely orphaned (orphaned-not-found or
 * exhausted-retries), never re-runs a workflow.
 *
 * Guide: https://www.allanninal.dev/medusa/scheduled-jobs-sporadic-redis-deploy/
 */
import { pathToFileURL } from "node:url";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME || "medusa-job-queue";
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 60000);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const STATES = ["failed", "active", "delayed", "waiting"];
const NOT_FOUND_RE = /Workflow with id .* not found/;
const REMOVABLE = new Set(["orphaned-not-found", "exhausted-retries"]);

export function classifyJob(job, now, stepTimeoutMs) {
  // Pure: no I/O. job is a plain object already read from Redis/BullMQ.
  //
  // Returns one of: 'healthy', 'stuck-active', 'orphaned-not-found',
  // 'exhausted-retries', 'pending-too-long'.
  const failedReason = job.failedReason;
  if (failedReason && NOT_FOUND_RE.test(failedReason)) {
    return "orphaned-not-found";
  }

  const { processedOn, finishedOn } = job;
  if (processedOn !== undefined && finishedOn === undefined && now - processedOn > stepTimeoutMs) {
    return "stuck-active";
  }

  const attemptsMade = job.attemptsMade ?? 0;
  const attemptsAllowed = job.opts?.attempts ?? 1;
  if (finishedOn === undefined && attemptsMade >= attemptsAllowed && failedReason) {
    return "exhausted-retries";
  }

  if (processedOn === undefined && job.timestamp !== undefined && now - job.timestamp > stepTimeoutMs) {
    return "pending-too-long";
  }

  return "healthy";
}

async function getConnection() {
  const { default: IORedis } = await import("ioredis");
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

async function openJobQueue(connection) {
  // PR #11740 split this out as a dedicated jobQueueName, separate
  // from the workflow transaction queueName.
  const { Queue } = await import("bullmq");
  return new Queue(JOB_QUEUE_NAME, { connection });
}

async function fetchJobs(jobQueue) {
  const bullJobs = await jobQueue.getJobs(STATES);
  return bullJobs.map((job) => ({
    bullJob: job,
    id: job.name || String(job.id),
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? undefined,
    finishedOn: job.finishedOn ?? undefined,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    opts: { attempts: job.opts?.attempts },
  }));
}

async function removeJob(bullJob) {
  // Delete a genuinely orphaned BullMQ job. Never call this on
  // stuck-active or pending-too-long jobs, since removing those hides
  // a hang instead of fixing it.
  await bullJob.remove();
}

export async function run() {
  const connection = await getConnection();
  const jobQueue = await openJobQueue(connection);
  const now = Date.now();

  try {
    const jobs = await fetchJobs(jobQueue);
    const flagged = [];

    for (const job of jobs) {
      const classification = classifyJob(job, now, STEP_TIMEOUT_MS);
      if (classification === "healthy") continue;
      flagged.push({ job, classification });
      console.warn(
        `Job ${job.id} classified ${classification}. failedReason=${job.failedReason} attemptsMade=${job.attemptsMade}/${job.opts.attempts}`
      );
    }

    if (flagged.length === 0) {
      console.log(`No stuck or orphaned jobs across ${jobs.length} entr(y/ies).`);
      return;
    }

    if (!DRY_RUN) {
      for (const { job, classification } of flagged) {
        if (REMOVABLE.has(classification)) {
          console.log(`Removing orphaned job ${job.id} (${classification}).`);
          await removeJob(job.bullJob);
        }
      }
    }

    console.log(`Done. ${flagged.length} job(s) ${DRY_RUN ? "to review" : "processed"}.`);
  } finally {
    await jobQueue.close();
    connection.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
