/**
 * Find and safely repair broken Medusa v2 product image links.
 *
 * Medusa stores thumbnail and each images[].url as a plain string and never
 * re-validates it at read time. A redeploy with the Local File Module
 * Provider, an ephemeral container restart, a domain change, or a file
 * provider migration all leave old URLs pointing at nothing. This script
 * paginates every product, checks every unique image URL with a HEAD
 * request, classifies each one with a pure function, and only ever clears a
 * confirmed-broken field. It never guesses a replacement URL. Run on a
 * schedule or by hand. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/broken-product-image-links/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIGURED_IMAGE_HOSTS = (process.env.CONFIGURED_IMAGE_HOSTS || "localhost:9000")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

/**
 * Pure decision function. No I/O.
 *
 * 1. A URL that does not parse as absolute is malformed.
 * 2. A network error, missing status, or a 4xx/5xx status is unreachable.
 * 3. A host that is not in configuredHosts is foreign_host, even if it
 *    happened to answer, since that is a strong signal of a stale provider
 *    URL or a pre-migration bucket.
 * 4. Otherwise the URL is ok.
 *
 * @param {{url: string, status: number|null, error: string|null, configuredHosts: string[]}} check
 * @returns {{state: "ok"|"unreachable"|"foreign_host"|"malformed", reason: string}}
 */
export function classifyImageHealth(check) {
  const url = check.url || "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "malformed", reason: "not a valid absolute URL" };
  }

  const { status, error } = check;
  if (error || status === null || status === undefined || status >= 400) {
    return { state: "unreachable", reason: `status ${status ?? "network_error"}` };
  }

  const host = parsed.hostname.toLowerCase();
  const configured = (check.configuredHosts || []).map((h) => h.toLowerCase());
  if (!configured.includes(host)) {
    return {
      state: "foreign_host",
      reason: "points at a non-current storage host (likely stale provider/migration)",
    };
  }

  return { state: "ok", reason: "resolves on a currently configured host" };
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  return (await res.json()).token;
}

async function* listProductsWithImages(token) {
  const limit = 100;
  let offset = 0;
  while (true) {
    const url = new URL(`${BACKEND_URL}/admin/products`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fields", "id,title,thumbnail,*images");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status} on GET /admin/products`);
    const body = await res.json();
    for (const product of body.products) yield product;
    offset += limit;
    if (offset >= body.count) return;
  }
}

function imageEntries(product) {
  const entries = [];
  if (product.thumbnail) entries.push({ field: "thumbnail", url: product.thumbnail });
  (product.images || []).forEach((image, i) => {
    if (image.url) entries.push({ field: `images[${i}].url`, url: image.url });
  });
  return entries;
}

async function checkUrl(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", signal: controller.signal });
    if (res.status === 405) {
      res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: controller.signal });
    }
    return { status: res.status, error: null };
  } catch (err) {
    return { status: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function clearBrokenField(token, product, field, url, dryRun) {
  const body = field === "thumbnail"
    ? { thumbnail: null }
    : { images: (product.images || []).filter((img) => img.url !== url) };

  console.warn(`${dryRun ? "Would clear" : "Clearing"} product ${product.id} field ${field}`);
  if (dryRun) return null;

  const res = await fetch(`${BACKEND_URL}/admin/products/${product.id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST /admin/products/${product.id}`);
  return (await res.json()).product;
}

export async function run() {
  const token = await getAdminToken();
  const checkedUrls = new Map();
  let broken = 0;

  for await (const product of listProductsWithImages(token)) {
    for (const entry of imageEntries(product)) {
      const { url } = entry;
      if (!checkedUrls.has(url)) {
        checkedUrls.set(url, await checkUrl(url));
      }
      const result = checkedUrls.get(url);

      const verdict = classifyImageHealth({
        url,
        status: result.status,
        error: result.error,
        configuredHosts: CONFIGURED_IMAGE_HOSTS,
      });

      if (verdict.state === "ok") continue;

      console.warn(
        `Product ${product.id} (${product.title}) field ${entry.field} state=${verdict.state} ` +
        `reason=${verdict.reason} url=${url}`
      );
      await clearBrokenField(token, product, entry.field, url, DRY_RUN);
      broken++;
    }
  }

  console.log(`Done. ${broken} broken image entr${broken === 1 ? "y" : "ies"} ${DRY_RUN ? "to clear" : "cleared"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
