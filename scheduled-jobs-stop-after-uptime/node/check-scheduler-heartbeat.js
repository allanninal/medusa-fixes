/**
 * Detect a stalled Medusa v2 scheduler caused by a hung workflow step
 * occupying the only BullMQ worker slot (jobWorkerOptions.concurrency=1
 * by default on @medusajs/medusa/workflow-engine-redis). There is no
 * Admin API route that can kill a stuck job or restart the scheduler,
 * so this only flags the stall and alerts an operator to restart the
 * worker process. DRY_RUN=true only logs locally; DRY_RUN=false also
 * calls the alert webhook. Never writes anything to Medusa itself.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const STOCK_LOCATION_ID = process.env.HEARTBEAT_STOCK_LOCATION_ID || "sloc_heartbeat";
const HEARTBEAT_CRON = process.env.HEARTBEAT_CRON || "*/5 * * * *";
const TOLERANCE_MULTIPLIER = Number(process.env.TOLERANCE_MULTIPLIER || 3);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

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

function nextRunAfter(cronExpression, after, limitMinutes = 527040) {
  // Smallest minute-aligned date strictly after `after` matching the cron spec.
  const spec = parseCron(cronExpression);
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < limitMinutes; i++) {
    if (matches(cursor, spec)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error("No matching run found within search window");
}

export function expectedIntervalMs(cronExpression, anchor) {
  // The gap, in ms, between two consecutive matches of cronExpression near anchor.
  const firstRun = nextRunAfter(cronExpression, anchor);
  const secondRun = nextRunAfter(cronExpression, firstRun);
  return secondRun.getTime() - firstRun.getTime();
}

export function isSchedulerStalled(lastRunAt, now, cronSchedule, toleranceMultiplier = 3) {
  // Pure: no I/O. True iff the gap since lastRunAt exceeds the schedule's
  // expected interval times toleranceMultiplier.
  const intervalMs = expectedIntervalMs(cronSchedule, lastRunAt);
  const gapMs = now.getTime() - lastRunAt.getTime();
  return gapMs > intervalMs * toleranceMultiplier;
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

async function getHeartbeatLastRunAt(token, stockLocationId) {
  const res = await fetch(
    `${BASE_URL}/admin/stock-locations?fields=id,metadata&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  const loc = body.stock_locations.find((l) => l.id === stockLocationId);
  return loc?.metadata?.heartbeat_last_run_at ?? null;
}

async function alertStalledScheduler(gapMinutes, webhookUrl) {
  const message =
    `Medusa scheduler looks stalled. No heartbeat for ${gapMinutes.toFixed(1)} minutes. ` +
    "A workflow step is likely stuck occupying the only BullMQ worker slot " +
    "(jobWorkerOptions.concurrency=1). Restart the worker process " +
    "(MEDUSA_WORKER_MODE=worker) to recover. Consider raising concurrency and " +
    "adding step-level timeouts to prevent this recurring.";
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  }
  return message;
}

export async function run() {
  const token = await getToken();
  const lastRunIso = await getHeartbeatLastRunAt(token, STOCK_LOCATION_ID);
  const now = new Date();

  if (!lastRunIso) {
    console.warn("No heartbeat recorded yet at all. Treating as stalled.");
    const message = await alertStalledScheduler(Infinity, DRY_RUN ? "" : ALERT_WEBHOOK_URL);
    console.warn(message);
    return;
  }

  const lastRunAt = new Date(lastRunIso);
  const stalled = isSchedulerStalled(lastRunAt, now, HEARTBEAT_CRON, TOLERANCE_MULTIPLIER);
  const gapMinutes = (now.getTime() - lastRunAt.getTime()) / 60000;

  if (!stalled) {
    console.log(`Scheduler healthy. Last heartbeat ${gapMinutes.toFixed(1)} minute(s) ago.`);
    return;
  }

  console.warn(`Scheduler stalled. Last heartbeat ${gapMinutes.toFixed(1)} minute(s) ago.`);
  const message = await alertStalledScheduler(gapMinutes, DRY_RUN ? "" : ALERT_WEBHOOK_URL);
  console.warn(message);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
