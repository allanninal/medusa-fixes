/**
 * Flag Medusa workflow_execution rows stuck in the invoking state.
 *
 * Medusa only persists a workflow_execution row when a workflow is marked store: true,
 * which long running workflows get automatically, and the row's state is meant to move
 * through invoking to done, failed, or compensating as async steps complete. An async
 * step (async: true, or one with a retryInterval) only advances the row when it gets its
 * external completion signal: a webhook calling setStepSuccess, a worker checking back in,
 * a subscriber firing. If that signal never arrives, the row is stuck mid invoke, and
 * without an explicit retentionTime there is no built in TTL sweep to expire it, so it can
 * sit there indefinitely (GitHub #9077, #11175).
 *
 * This connects read only to Postgres, lists rows still in the invoking state, flags the
 * ones stuck past an expected TTL with a pure function, and reports the transaction ids
 * for an operator to retry with the Workflow Engine Module's retryStep. It never deletes
 * or updates workflow_execution directly. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/workflow-execution-stuck-invoking/
 */
import { pathToFileURL } from "node:url";

const DATABASE_URL = process.env.MEDUSA_DATABASE_URL || "postgres://user:pass@localhost:5432/medusa";
const DEFAULT_TTL_MINUTES = Number(process.env.DEFAULT_TTL_MINUTES || 20);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Per workflow_id TTL overrides, in minutes. Extend this if a workflow legitimately
// needs longer than DEFAULT_TTL_MINUTES to receive its async completion signal.
const TTL_MINUTES_BY_WORKFLOW = {};

const INVOKING_QUERY = `
  SELECT id, workflow_id, transaction_id, state, retention_time, created_at, updated_at
  FROM workflow_execution
  WHERE state = 'invoking'
`;

/**
 * Pure decision function. No I/O.
 *
 * @param {{ state: string, createdAt: Date, updatedAt: Date | null, workflowId: string }} row
 * @param {number} nowMs
 * @param {Record<string, number>} ttlMsByWorkflow
 * @param {number} defaultTtlMs
 * @returns {boolean}
 */
export function isStuckInvoking(row, nowMs, ttlMsByWorkflow, defaultTtlMs) {
  if (row.state !== "invoking") return false;

  const reference = row.updatedAt ?? row.createdAt;
  if (!reference) return false;

  const ttlMs = ttlMsByWorkflow[row.workflowId] ?? defaultTtlMs;
  const elapsedMs = nowMs - reference.getTime();
  return elapsedMs > ttlMs;
}

/**
 * Pure. Returns the set of transaction_ids seen before, missing last poll,
 * and present again now (present -> absent -> present).
 *
 * @param {Set<string>} previousIds
 * @param {Set<string>} currentIds
 * @param {Set<string>} everSeenIds
 * @returns {Set<string>}
 */
export function detectFlapping(previousIds, currentIds, everSeenIds) {
  const missingLastPoll = [...everSeenIds].filter((id) => !previousIds.has(id));
  return new Set(missingLastPoll.filter((id) => currentIds.has(id)));
}

async function listInvokingRows() {
  // Imported lazily so importing this module (for the pure functions or their
  // tests) never requires the pg package to be installed.
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(INVOKING_QUERY);
    return rows;
  } finally {
    await pool.end();
  }
}

export async function run() {
  const nowMs = Date.now();
  const ttlMsByWorkflow = Object.fromEntries(
    Object.entries(TTL_MINUTES_BY_WORKFLOW).map(([k, v]) => [k, v * 60000])
  );
  const defaultTtlMs = DEFAULT_TTL_MINUTES * 60000;

  const rows = await listInvokingRows();
  const stuck = rows.filter((row) =>
    isStuckInvoking(
      {
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        workflowId: row.workflow_id,
      },
      nowMs,
      ttlMsByWorkflow,
      defaultTtlMs
    )
  );

  if (DRY_RUN) {
    console.log("Dry run. Reporting only, no state is ever changed by this script.");
  }

  for (const row of stuck) {
    const reference = row.updated_at || row.created_at;
    const elapsedMinutes = (nowMs - new Date(reference).getTime()) / 60000;
    console.warn(
      `Stuck invoking: transaction_id=${row.transaction_id} workflow_id=${row.workflow_id} elapsed=${elapsedMinutes.toFixed(1)}min. ` +
      `Operator action: retryStep, or cancel via the workflow's own compensation.`
    );
  }

  console.log(`Done. ${stuck.length} workflow_execution row(s) stuck on invoking out of ${rows.length} total in that state.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
