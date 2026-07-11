/**
 * Find custom module link rows left dangling by a product delete that did not cascade.
 *
 * Medusa v2 module links live in a pivot table outside both linked modules' own
 * schemas, by design, to keep modules isolated. Cascade on delete is opt-in via
 * deleteCascade in the defineLink call, and even then it is only honored when the
 * deletion runs through Medusa's own Link/Remote Link APIs or workflow steps, such
 * as deleteProductsWorkflow, removeRemoteLinkStep, or link.delete. A raw module
 * service delete or a direct SQL delete on the product bypasses that cascade
 * entirely, leaving rows in the custom link table pointing at a prod_ id that no
 * longer exists. This script lists every live product id, lists every product_id
 * your custom link table currently stores, diffs the two sets with a pure function,
 * and cross-checks each candidate with a 404 lookup before reporting it. It only
 * reports by default. Hard-deleting or soft-deleting a confirmed dangling row must
 * run from inside a Medusa server context that can resolve your custom module's
 * own service, so that part is documented in the guide, not executed by this script.
 *
 * Guide: https://www.allanninal.dev/medusa/custom-link-no-cascade-delete/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function: a link row is dangling iff its product_id is not
 * a member of the current live-product id set.
 *
 * @param {Set<string>} liveProductIds - set of live "prod_..." ids.
 * @param {Array<{id: string, product_id: string}>} linkRows - stored link rows.
 * @returns {Array<{id: string, product_id: string}>} the dangling subset.
 */
export function findDanglingLinks(liveProductIds, linkRows) {
  return linkRows.filter((row) => !liveProductIds.has(row.product_id));
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

async function listLiveProductIds(token) {
  const ids = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const url = new URL(`${BASE}/admin/products`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    ids.push(...body.products.map((p) => p.id));
    offset += limit;
    if (offset >= body.count) return ids;
  }
}

async function listCustomLinkRows(token) {
  const url = new URL(`${BASE}/admin/custom-entities`);
  url.searchParams.set("fields", "id,product_id");
  url.searchParams.set("limit", "1000");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.custom_entities;
}

async function productIsGone(token, productId) {
  const url = new URL(`${BASE}/admin/products/${productId}`);
  url.searchParams.set("with_deleted", "true");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.status === 404;
}

export async function run() {
  const token = await login();
  const liveIds = new Set(await listLiveProductIds(token));
  const linkRows = await listCustomLinkRows(token);
  const candidates = findDanglingLinks(liveIds, linkRows);

  let confirmed = 0;
  for (const row of candidates) {
    if (!(await productIsGone(token, row.product_id))) continue;
    confirmed++;
    console.warn(
      `Dangling link row ${row.id} -> product ${row.product_id}. ${DRY_RUN ? "would report" : "confirmed, repair runs server-side"}`
    );
  }
  console.log(`Done. ${confirmed} dangling link row(s) confirmed out of ${candidates.length} candidate(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
