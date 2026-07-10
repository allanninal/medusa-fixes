/**
 * Find Medusa v2 records whose scheduled job missed a run, because the
 * instance never registered the job in server-only WORKER_MODE, or the
 * default in-memory workflow engine dropped the tick across a restart.
 * Never replays a cron tick generically. DRY_RUN=true only reports the
 * flagged records. Safe to run again and again, because repair writes a
 * last_synced_at marker that stops the same gap from being reprocessed.
 *
 * Guide: https://www.allanninal.dev/medusa/scheduled-job-did-not-run/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const JOB_CRON = process.env.JOB_CRON || "0 * * * *";
const GRACE_MULTIPLIER = Number(process.env.GRACE_MULTIPLIER || 1.5);

const PRICE_LIST_FIELDS = "id,title,ends_at,updated_at";

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

export function nextRunAfter(cronExpression, after, limitMinutes = 527040) {
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

export function findMissedRuns(records, cronExpression, now, graceMultiplier = 1.5) {
  // Pure: no I/O. records is a plain array of { id, lastRunAt } already fetched.
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const anchor = nextRunAfter(cronExpression, dayAgo);
  const intervalMs = nextRunAfter(cronExpression, anchor).getTime() - anchor.getTime();
  const missed = [];

  for (const record of records) {
    if (record.lastRunAt === null || record.lastRunAt === undefined) {
      missed.push({ id: record.id, expectedRunAt: now, missedByMs: intervalMs * graceMultiplier + 1 });
      continue;
    }

    // The tick that should have fired right after the record's own last run.
    const expectedRunAt = nextRunAfter(cronExpression, record.lastRunAt);
    const gapMs = now.getTime() - expectedRunAt.getTime();

    if (gapMs > intervalMs * graceMultiplier && new Date(record.lastRunAt).getTime() < expectedRunAt.getTime()) {
      missed.push({ id: record.id, expectedRunAt, missedByMs: gapMs });
    }
  }

  return missed.sort((a, b) => b.missedByMs - a.missedByMs);
}

function toRecord(priceList) {
  // Adapt a Medusa price list into the { id, lastRunAt } shape the pure function expects.
  const lastRunIso = priceList.updated_at || priceList.ends_at;
  return { id: priceList.id, lastRunAt: lastRunIso ? new Date(lastRunIso) : null };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listPriceLists(sdk, limit = 100) {
  const out = [];
  let offset = 0;
  while (true) {
    const body = await sdk.admin.priceList.list({
      fields: PRICE_LIST_FIELDS, limit, offset,
    });
    out.push(...body.price_lists);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function markSynced(sdk, priceListId, syncedAtIso) {
  return sdk.client.fetch(`/admin/price-lists/${priceListId}`, {
    method: "POST",
    body: { metadata: { last_synced_at: syncedAtIso } },
  });
}

async function rerunExpirySweepForOne(priceListId) {
  // Invoke the same workflow src/jobs/expire-price-lists.ts would run,
  // scoped to exactly one record so a missed tick affects nothing else.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("npx", ["medusa", "exec", "./src/scripts/expire-one-price-list.ts", priceListId]);
}

export async function run() {
  const sdk = await login();
  const priceLists = await listPriceLists(sdk);
  const byId = new Map(priceLists.map((p) => [p.id, p]));

  const records = priceLists.map(toRecord);
  const now = new Date();
  const missed = findMissedRuns(records, JOB_CRON, now, GRACE_MULTIPLIER);

  if (missed.length === 0) {
    console.log(`No missed runs across ${priceLists.length} record(s).`);
    return;
  }

  for (const item of missed) {
    const title = byId.get(item.id)?.title;
    console.warn(
      `Record ${item.id} (${title}) missed run expected at ${item.expectedRunAt.toISOString()}, missed by ${Math.round(item.missedByMs)} ms.`
    );
  }

  if (!DRY_RUN) {
    const syncedAtIso = now.toISOString();
    for (const item of missed) {
      console.log(`Record ${item.id}: re-running expiry sweep.`);
      await rerunExpirySweepForOne(item.id);
      await markSynced(sdk, item.id, syncedAtIso);
    }
  }

  console.log(`Done. ${missed.length} record(s) ${DRY_RUN ? "to review" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
