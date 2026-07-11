/**
 * Find Medusa v2 events that the Redis event bus processed with 0
 * subscribers because the event-bus-redis module's BullMQ worker started
 * consuming before the later src/subscribers loader phase finished
 * registering handlers, typically right after a redeploy or a
 * horizontal-scale restart. Never auto-re-emits by default. DRY_RUN=true
 * only reports the confirmed gaps found in the boot log. Repair only
 * re-publishes an event under DRY_RUN=false, using data pulled fresh from
 * the Admin API, and only once the operator has confirmed the handler is
 * idempotent.
 *
 * Guide: https://www.allanninal.dev/medusa/events-race-subscriber-boot/
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const BOOT_LOG_PATH = process.env.BOOT_LOG_PATH || "/var/log/medusa/boot.log";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const LOG_LINE = /^\[(?<ts>[^\]]+)\]\s+(?<msg>.*)$/;
const ZERO_SUB = /Processing\s+(?<event>\S+)\s+which has 0 subscribers/;
const LOADER_DONE = /subscribers loaded/i;

function toEpochMs(ts) {
  return Date.parse(ts);
}

export function parseBootLog(path) {
  // Read the boot log once. Returns { bootLog, subscriberLoaderDoneAtMs }.
  const text = readFileSync(path, "utf-8");
  const bootLog = [];
  let subscriberLoaderDoneAtMs = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(LOG_LINE);
    if (!m) continue;
    const atMs = toEpochMs(m.groups.ts);
    const msg = m.groups.msg;
    const zero = msg.match(ZERO_SUB);
    if (zero) {
      bootLog.push({ event: zero.groups.event, atMs });
    } else if (LOADER_DONE.test(msg) && subscriberLoaderDoneAtMs === null) {
      subscriberLoaderDoneAtMs = atMs;
    }
  }
  return { bootLog, subscriberLoaderDoneAtMs };
}

export function findMissedEventWindows(bootLog, subscriberLoaderDoneAtMs) {
  // Pure: no I/O. bootLog is a plain array of { event, atMs } already parsed
  // from lines like "Processing <eventName> which has 0 subscribers".
  // An event was missed iff it was processed strictly before the subscriber
  // loader finished registering handlers.
  return bootLog
    .filter((e) => e.atMs < subscriberLoaderDoneAtMs)
    .map((e) => ({ event: e.event, atMs: e.atMs, gapMs: subscriberLoaderDoneAtMs - e.atMs }));
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function ordersMissingNotifications(sdk, restartIso) {
  // Diff orders created since the restart against notifications sent since
  // the restart, for order.placed style gaps. Returns order ids with no
  // matching notification record.
  const { orders } = await sdk.client.fetch("/admin/orders", {
    query: { fields: "id,status,*fulfillments,*payment_collection", "created_at[$gte]": restartIso },
  });
  const { notifications } = await sdk.client.fetch("/admin/notifications", {
    query: { fields: "id,to,template,data", "created_at[$gte]": restartIso },
  });
  const notifiedOrderIds = new Set(notifications.map((n) => n.data?.id).filter(Boolean));
  return orders.filter((o) => !notifiedOrderIds.has(o.id)).map((o) => o.id);
}

async function reemitOrderPlaced(sdk, orderId) {
  // Only called when DRY_RUN=false and the operator confirmed the handler
  // is idempotent. Sources fresh payload from the Admin API, not the
  // original stale event.
  const { order } = await sdk.client.fetch(`/admin/orders/${orderId}`, {
    query: { fields: "id,*items,*customer" },
  });
  // In the Medusa backend process itself, inside a workflow:
  //   import { emitEventStep } from "@medusajs/medusa/core-flows"
  //   emitEventStep({ eventName: "order.placed", data: order })
  return order;
}

export async function run() {
  const { bootLog, subscriberLoaderDoneAtMs } = parseBootLog(BOOT_LOG_PATH);
  if (subscriberLoaderDoneAtMs === null) {
    console.warn(`Subscriber loader done marker not found in ${BOOT_LOG_PATH}. Nothing to compare.`);
    return;
  }

  const missed = findMissedEventWindows(bootLog, subscriberLoaderDoneAtMs);
  if (missed.length === 0) {
    console.log(`No confirmed gaps. ${bootLog.length} event(s) processed, all after the subscriber loader finished.`);
    return;
  }

  for (const item of missed) {
    console.warn(`Event ${item.event} processed ${Math.round(item.gapMs)} ms before subscribers finished loading. Confirmed gap.`);
  }

  if (!DRY_RUN) {
    const sdk = await login();
    const restartIso = new Date(Math.min(...missed.map((e) => e.atMs))).toISOString();
    const orderIds = await ordersMissingNotifications(sdk, restartIso);
    for (const orderId of orderIds) {
      console.log(`Order ${orderId} has no matching notification. Re-emitting order.placed.`);
      await reemitOrderPlaced(sdk, orderId);
    }
  }

  console.log(`Done. ${missed.length} event(s) ${DRY_RUN ? "to review" : "reported and cross-checked"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
