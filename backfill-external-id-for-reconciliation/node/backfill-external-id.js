/**
 * Backfill metadata.external_id on Medusa orders for cross-system reconciliation.
 *
 * Medusa v2's Order module has no first-class external_id column. The official
 * ERP integration recipe stores it under metadata.external_id, a generic JSONB
 * field, instead of a structured one. Orders created before an integration
 * existed, imported by a seed script, or created through a flow that dropped
 * metadata along the way, end up with metadata null or missing that key, and
 * there is no built-in mechanism to recover the mapping once it is lost.
 *
 * This lists orders missing metadata.external_id, matches each one against a
 * legacy CSV export by display_id when available or by email, total, and
 * created_at otherwise, and only applies the id when exactly one legacy row
 * matches. Orders with zero or multiple matches are flagged for manual
 * reconciliation, never guessed. Metadata is always fully resent on update,
 * since Medusa v2 replaces nested metadata rather than merging it.
 * Run once with DRY_RUN=true for a CSV report before flipping to false.
 *
 * Guide: https://www.allanninal.dev/medusa/backfill-external-id-for-reconciliation/
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const LEGACY_EXPORT_PATH = process.env.LEGACY_EXPORT_PATH || "legacy_orders.csv";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const TOTAL_EPSILON = 0.01;
const DAY_WINDOW_MS = 86400 * 1000;
const ORDER_FIELDS = "id,display_id,created_at,email,*metadata";

function matchesFuzzy(order, candidate) {
  if (!(order.email && candidate.email)) return false;
  if (order.email.trim().toLowerCase() !== candidate.email.trim().toLowerCase()) return false;
  if (candidate.total == null || order.total == null) return false;
  if (Math.abs(candidate.total - order.total) > TOTAL_EPSILON) return false;
  const orderMs = order.created_at ? Date.parse(order.created_at) : NaN;
  const candidateMs = candidate.created_at ? Date.parse(candidate.created_at) : NaN;
  if (Number.isNaN(orderMs) || Number.isNaN(candidateMs)) return false;
  return Math.abs(orderMs - candidateMs) <= DAY_WINDOW_MS;
}

/**
 * Pure decision function. No I/O.
 *
 * 1. If order.metadata.external_id is already a non-empty string, skip.
 * 2. Filter legacyCandidates to those matching on display_id if the order
 *    has one, else on (email && total within epsilon && created_at within
 *    a day window).
 * 3. Exactly one candidate matches -> apply that candidate's legacyId.
 * 4. Zero candidates match -> flag_no_match.
 * 5. More than one candidate matches -> flag_ambiguous. Never guess.
 *
 * @param {{ id: string, display_id: number, metadata: Record<string, unknown> | null,
 *           created_at: string, email?: string, total?: number }} order
 * @param {Array<{ legacyId: string, display_id?: number, email?: string,
 *                  total?: number, created_at?: string }>} legacyCandidates
 * @returns {{ action: "skip_has_id"|"apply"|"flag_ambiguous"|"flag_no_match",
 *             external_id?: string, reason: string }}
 */
export function decideExternalIdBackfill(order, legacyCandidates) {
  const existing = (order.metadata || {}).external_id;
  if (typeof existing === "string" && existing.trim()) {
    return { action: "skip_has_id", reason: "metadata.external_id already set" };
  }

  let matches;
  if (order.display_id != null) {
    matches = legacyCandidates.filter(
      (c) => c.display_id != null && c.display_id === order.display_id
    );
  } else {
    matches = legacyCandidates.filter((c) => matchesFuzzy(order, c));
  }

  if (matches.length === 1) {
    return {
      action: "apply",
      external_id: matches[0].legacyId,
      reason: "exactly one legacy candidate matched",
    };
  }
  if (matches.length === 0) {
    return { action: "flag_no_match", reason: "no legacy candidate matched" };
  }
  return {
    action: "flag_ambiguous",
    reason: `${matches.length} legacy candidates matched, refusing to guess`,
  };
}

export function loadLegacyCandidates(path) {
  const [header, ...rows] = readFileSync(path, "utf-8").trim().split("\n");
  const cols = header.split(",");
  return rows.filter(Boolean).map((line) => {
    const cells = line.split(",");
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
    return {
      legacyId: row.legacy_id,
      display_id: row.display_id ? Number(row.display_id) : null,
      email: row.email || null,
      total: row.total ? Number(row.total) : null,
      created_at: row.created_at || null,
    };
  });
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function adminGet(token, path, params = {}) {
  const url = new URL(`${BACKEND_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status} on GET ${path}`);
  return res.json();
}

async function adminPost(token, path, jsonBody) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jsonBody),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST ${path}`);
  return res.json();
}

async function listOrdersMissingExternalId(token) {
  const missing = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: ORDER_FIELDS,
      limit,
      offset,
    });
    for (const order of data.orders) {
      const metadata = order.metadata || {};
      if (!metadata.external_id) missing.push(order);
    }
    offset += limit;
    if (offset >= data.count) return missing;
  }
}

async function applyExternalId(token, order, externalId) {
  const existingMetadata = order.metadata || {};
  return adminPost(token, `/admin/orders/${order.id}`, {
    metadata: { ...existingMetadata, external_id: externalId },
  });
}

export async function run() {
  const token = await getAdminToken();
  const legacyCandidates = loadLegacyCandidates(LEGACY_EXPORT_PATH);
  const orders = await listOrdersMissingExternalId(token);

  const rows = [["medusa_order_id", "display_id", "external_id", "action"]];
  let applied = 0;
  let flagged = 0;

  for (const order of orders) {
    const outcome = decideExternalIdBackfill(order, legacyCandidates);
    const action = outcome.action;

    if (action === "skip_has_id") continue;

    if (action === "apply") {
      const externalId = outcome.external_id;
      console.log(
        `Order ${order.display_id || order.id} matched legacy id ${externalId}. ${DRY_RUN ? "would apply" : "applying"}`
      );
      if (!DRY_RUN) await applyExternalId(token, order, externalId);
      rows.push([order.id, order.display_id ?? "", externalId, "apply"]);
      applied++;
    } else {
      console.warn(`Order ${order.display_id || order.id} ${action}: ${outcome.reason}`);
      rows.push([order.id, order.display_id ?? "", "", action]);
      flagged++;
    }
  }

  for (const row of rows) console.log(row.join(","));

  console.log(
    `Done. ${applied} order(s) ${DRY_RUN ? "to backfill" : "backfilled"}, ${flagged} order(s) flagged for manual reconciliation.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
