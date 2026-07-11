/**
 * Find Medusa v2 scheduled job ticks that fired more than once, because
 * more than one process is running in shared or worker WORKER_MODE against
 * the same database, with no distributed lock coordinating them.
 *
 * This is an infrastructure and config defect, not a data problem. It only
 * reports the duplicate ticks, it never resends a suppressed side effect
 * and never deletes a workflow_execution row. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/scheduled-job-runs-twice/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const JOB_WORKFLOW_ID = process.env.JOB_WORKFLOW_ID || "job-name";
const JOB_CRON = process.env.JOB_CRON || "*/15 * * * *";
const BUCKET_TOLERANCE_MS = Number(process.env.BUCKET_TOLERANCE_MS || 5000);

const EXECUTION_FIELDS = "id,transaction_id,workflow_id,created_at,state";

function parseField(field, lo, hi) {
  if (field === "*") return new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  const values = new Set();
  for (const part of field.split(",")) {
    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      for (let v = lo; v <= hi; v += step) values.add(v);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let v = a; v <= b; v++) values.add(v);
    } else {
      values.add(Number(part));
    }
  }
  return values;
}

function parseCron(cronExpression) {
  const [minute, hour, dom, month, dow] = cronExpression.trim().split(/\s+/);
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dow: parseField(dow, 0, 6),
  };
}

function fullRange(lo, hi) {
  return new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
}

function matches(date, spec) {
  if (!spec.minute.has(date.getUTCMinutes())) return false;
  if (!spec.hour.has(date.getUTCHours())) return false;
  if (!spec.month.has(date.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(date.getUTCDate());
  const dowOk = spec.dow.has(date.getUTCDay());
  const domIsFull = spec.dom.size === fullRange(1, 31).size;
  const dowIsFull = spec.dow.size === fullRange(0, 6).size;
  if (!domIsFull && !dowIsFull) return domOk || dowOk;
  return domOk && dowOk;
}

export function nearestTickBoundary(cronExpression, at, searchMinutes = 1440) {
  // Minute-aligned tick boundary matching the cron spec closest to `at`.
  const spec = parseCron(cronExpression);
  const base = new Date(at.getTime());
  base.setUTCSeconds(0, 0);
  if (matches(base, spec)) return base;
  for (let offset = 1; offset <= searchMinutes; offset++) {
    const earlier = new Date(base.getTime() - offset * 60000);
    if (matches(earlier, spec)) return earlier;
    const later = new Date(base.getTime() + offset * 60000);
    if (matches(later, spec)) return later;
  }
  throw new Error("No matching tick boundary found within search window");
}

export function findDuplicateTicks(executions, cronSchedule, bucketToleranceMs = 5000) {
  // Pure: no I/O, no clock access. executions is a plain array of
  // { workflow_id, transaction_id, created_at } already fetched.
  const byWorkflow = new Map();
  for (const execution of executions) {
    const list = byWorkflow.get(execution.workflow_id) || [];
    list.push(execution);
    byWorkflow.set(execution.workflow_id, list);
  }

  const duplicates = [];
  for (const rows of byWorkflow.values()) {
    const buckets = new Map();
    for (const row of rows) {
      const createdAt = new Date(row.created_at);
      const tick = nearestTickBoundary(cronSchedule, createdAt);
      const deltaMs = Math.abs(createdAt.getTime() - tick.getTime());
      if (deltaMs > bucketToleranceMs) continue;
      const key = tick.toISOString();
      const set = buckets.get(key) || new Set();
      set.add(row.transaction_id);
      buckets.set(key, set);
    }

    for (const [tickBucket, txIds] of buckets.entries()) {
      if (txIds.size > 1) {
        duplicates.push({ tickBucket, transactionIds: [...txIds].sort() });
      }
    }
  }

  return duplicates.sort((a, b) => a.tickBucket.localeCompare(b.tickBucket));
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listWorkflowExecutions(token, workflowId, limit = 200) {
  const params = new URLSearchParams({
    workflow_id: workflowId, fields: EXECUTION_FIELDS, limit: String(limit), order: "created_at",
  });
  const res = await fetch(`${BASE_URL}/admin/workflows-executions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.workflow_executions;
}

function writeAuditReport(jobName, duplicates) {
  // The only write this script does: an audit log line per duplicate tick.
  // Never resends a suppressed side effect, never deletes an execution row.
  for (const item of duplicates) {
    console.warn(
      `DUPLICATE TICK job=${jobName} tick=${item.tickBucket} transaction_ids=${JSON.stringify(item.transactionIds)} inferred_replicas=${item.transactionIds.length}`
    );
  }
}

export async function run() {
  const token = await getToken();
  const executions = await listWorkflowExecutions(token, JOB_WORKFLOW_ID);
  const duplicates = findDuplicateTicks(executions, JOB_CRON, BUCKET_TOLERANCE_MS);

  if (duplicates.length === 0) {
    console.log(`No duplicate ticks across ${executions.length} execution(s) for ${JOB_WORKFLOW_ID}.`);
    return;
  }

  for (const item of duplicates) {
    console.warn(`Tick ${item.tickBucket} fired ${item.transactionIds.length} time(s): ${JSON.stringify(item.transactionIds)}`);
  }

  if (!DRY_RUN) {
    writeAuditReport(JOB_WORKFLOW_ID, duplicates);
  }

  console.log(`Done. ${duplicates.length} duplicate tick(s) ${DRY_RUN ? "to review" : "reported"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
