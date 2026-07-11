/**
 * Flag Medusa product import transactions stuck at preprocessing.
 *
 * importProductsWorkflow, which powers POST /admin/products/import, deliberately
 * pauses at waitConfirmationProductImportStep after normalizeCsvStep finishes. That
 * pause is the preprocessing state, and the transaction sits idle in the workflow
 * engine's data store until something calls
 * POST /admin/products/import/:transaction_id/confirm, which runs setStepSuccess on
 * it. If that confirm call is dropped, the operator never notices the review prompt,
 * or the workflow engine's event bus is misconfigured, the transaction never resumes
 * and no product.created or product.updated event ever fires, since v2 only emits
 * those after the workflow fully succeeds.
 *
 * Medusa v2 has no route that lists every pending import, so this script keeps its
 * own tracking file of transaction_id, summary, and start time, and polls the
 * workflow engine's state for each tracked transaction. Anything still invoking or
 * waiting past IMPORT_TIMEOUT_MINUTES with no completion event observed is reported
 * as stuck. It never calls confirm on your behalf. Run on a schedule.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/csv-import-stuck-preprocessing/
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "https://your-medusa-backend.com";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const IMPORT_TIMEOUT_MINUTES = Number(process.env.IMPORT_TIMEOUT_MINUTES || 15);
const TRACKING_FILE = process.env.IMPORT_TRACKING_FILE || "import_jobs.json";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ transactionId: string, createdAt: Date, workflowState: "invoking"|"waiting"|"done"|"failed"|"reverted", lastEventAt: Date|null }} job
 * @param {Date} now
 * @param {number} timeoutMs
 * @returns {{ status: "ok"|"completed"|"failed"|"stuck", minutesStuck: number }}
 */
export function classifyImportJob(job, now, timeoutMs) {
  if (job.workflowState === "done") {
    return { status: "completed", minutesStuck: 0 };
  }
  if (job.workflowState === "failed" || job.workflowState === "reverted") {
    return { status: "failed", minutesStuck: 0 };
  }

  const elapsedMs = now.getTime() - job.createdAt.getTime();
  const minutesStuck = elapsedMs / 60000;

  if (elapsedMs > timeoutMs && job.lastEventAt === null) {
    return { status: "stuck", minutesStuck };
  }
  return { status: "ok", minutesStuck };
}

function loadTrackedJobs() {
  if (!fs.existsSync(TRACKING_FILE)) return {};
  return JSON.parse(fs.readFileSync(TRACKING_FILE, "utf8"));
}

function saveTrackedJobs(jobs) {
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(jobs, null, 2));
}

async function getToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const body = await res.json();
  return body.token;
}

/**
 * Reads the workflow_execution row for this transaction via a custom read only
 * admin route that queries workflow_id = 'import-products'. Returns an object
 * like { state: "invoking", lastEventAt: null } or null if not found.
 */
async function fetchWorkflowState(token, transactionId) {
  const res = await fetch(
    `${BACKEND_URL}/admin/workflow-executions/import-products/${transactionId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

export async function run() {
  const jobs = loadTrackedJobs();
  if (Object.keys(jobs).length === 0) {
    console.log(`No tracked import transactions found in ${TRACKING_FILE}.`);
    return;
  }

  const token = await getToken();
  const timeoutMs = IMPORT_TIMEOUT_MINUTES * 60000;
  const now = new Date();
  let stuckCount = 0;

  for (const [transactionId, job] of Object.entries(jobs)) {
    const state = await fetchWorkflowState(token, transactionId);
    if (state === null) continue;

    const classifiedJob = {
      transactionId,
      createdAt: new Date(job.createdAt),
      workflowState: state.state,
      lastEventAt: state.lastEventAt ? new Date(state.lastEventAt) : null,
    };
    const result = classifyImportJob(classifiedJob, now, timeoutMs);

    if (result.status === "stuck") {
      stuckCount++;
      console.warn(
        `STUCK import: transaction_id=${transactionId} summary=${JSON.stringify(job.summary)} ` +
        `minutes_stuck=${result.minutesStuck.toFixed(1)} workflow_state=${classifiedJob.workflowState}. ` +
        `Operator action: inspect the summary, then either confirm to resume it or discard it and re-submit a fresh import.`
      );
      if (!DRY_RUN) job.flagged_stale = true;
    } else if (result.status === "completed" || result.status === "failed") {
      delete jobs[transactionId];
    }
  }

  saveTrackedJobs(jobs);
  console.log(`Done. ${stuckCount} import transaction(s) flagged stuck out of ${Object.keys(jobs).length} tracked.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
