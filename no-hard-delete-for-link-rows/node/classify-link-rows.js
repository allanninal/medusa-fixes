/**
 * Classify Medusa link table rows left behind because there is no hard delete.
 *
 * Medusa v2's Module Links deliberately expose only soft-delete style operations.
 * link.dismiss (and the dismissRemoteLinkStep workflow step) marks a link table
 * row with deleted_at rather than removing it, and link.delete only cascades when
 * the link definition is configured to. Medusa's core team confirmed on GitHub
 * (medusajs/medusa#13315) this is by design, not a bug, because a workflow step
 * must be reversible through compensation, and an irreversible hard delete of a
 * pivot row cannot be undone. When a linked entity is removed outside a workflow,
 * the matching link row is left behind, either live and pointing at a gone id, or
 * already soft-deleted, and no public API will ever purge either one.
 *
 * This script reads the live ids on both sides of a known link pair over the
 * Admin API, reads the raw link rows a companion medusa exec script exposed
 * (since getLinkModule only resolves inside a Medusa server context), classifies
 * every row with a pure function, and reports every row that is not already fine.
 * It only reports by default. Hard-deleting a confirmed orphan must run from
 * inside Medusa through link.getLinkModule, so that part is documented in the
 * guide, not executed by this external script.
 *
 * Guide: https://www.allanninal.dev/medusa/no-hard-delete-for-link-rows/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O, takes precomputed id sets.
 *
 * - A soft-deleted row (deletedAt is not null) is always reportable, since no
 *   public API ever purges it, regardless of whether the parents still exist.
 * - A live-looking row pointing at a missing parent is "orphan_dangling", the
 *   dangerous case since queries may still surface it.
 * - Anything else is "ok".
 */
export function classifyLinkRow(row, liveLeftIds, liveRightIds) {
  if (row.deletedAt !== null) return "orphan_soft_deleted";
  if (!liveLeftIds.has(row.leftId) || !liveRightIds.has(row.rightId)) return "orphan_dangling";
  return "ok";
}

async function login() {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listLiveIds(token, resource, key) {
  const ids = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const url = new URL(`${BASE}/admin/${resource}`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    ids.push(...body[key].map((row) => row.id));
    offset += limit;
    if (offset >= body.count) return ids;
  }
}

async function listLinkRows(token) {
  // Exposed by a companion medusa exec script that resolved
  // link.getLinkModule(...) and called linkModule.list({}, { withDeleted: true }).
  // Expected shape: [{ leftId, rightId, deletedAt: string|null }, ...]
  const url = new URL(`${BASE}/admin/link-rows`);
  url.searchParams.set("pair", "product_sales_channel");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.rows;
}

export async function run() {
  const token = await login();
  const liveLeftIds = new Set(await listLiveIds(token, "products", "products"));
  const liveRightIds = new Set(await listLiveIds(token, "sales-channels", "sales_channels"));
  const rows = await listLinkRows(token);

  let reportable = 0;
  for (const row of rows) {
    const status = classifyLinkRow(row, liveLeftIds, liveRightIds);
    if (status === "ok") continue;
    reportable++;
    console.warn(
      `Link row ${row.leftId} -> ${row.rightId} is ${status}. ${DRY_RUN ? "would report" : "confirmed, hard delete runs server-side"}`
    );
  }
  console.log(`Done. ${reportable} reportable row(s) out of ${rows.length} total.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
