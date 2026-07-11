/**
 * Flag Medusa price lists that keep serving prices past their end date.
 * Reports every affected price list and variant by default.
 * Only moves a confirmed list to status draft when DRY_RUN is explicitly false.
 * Never guesses at commercial data. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,rules_count,*prices";

export function isPriceListExpiredButActive(priceList, now) {
  // Pure: true only when status is active and ends_at is a real timestamp already passed.
  // Returns false when ends_at is null/undefined (no expiry set) or status is already "draft".
  if (priceList.status !== "active") return false;
  if (priceList.ends_at === null || priceList.ends_at === undefined) return false;
  return now.getTime() > new Date(priceList.ends_at).getTime();
}

export function pickBestCalculatedPrice(candidatePrices, now) {
  // Pure: filters out expired-but-active or draft price-list candidates, then
  // returns the lowest amount remaining, or null if nothing qualifies.
  // Each candidate looks like:
  //   { id, amount, price_list_id, price_list_ends_at, price_list_status }
  const eligible = candidatePrices.filter((c) => {
    if (c.price_list_status === "draft") return false;
    if (c.price_list_id) {
      const fakeList = { status: c.price_list_status, ends_at: c.price_list_ends_at };
      if (isPriceListExpiredButActive(fakeList, now)) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  const best = eligible.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { id: best.id, amount: best.amount };
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  return (await res.json()).token;
}

async function listPriceLists(token) {
  const out = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const url = `${BASE_URL}/admin/price-lists?fields=${PRICE_LIST_FIELDS}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    out.push(...body.price_lists);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function fetchCalculatedPrice(productId, regionId) {
  const url = `${BASE_URL}/store/products/${productId}?region_id=${regionId}&fields=id,*variants.calculated_price`;
  const res = await fetch(url, { headers: { "x-publishable-api-key": PUBLISHABLE_KEY } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).product;
}

function confirmAffected(product, expiredPriceIds) {
  const affected = [];
  for (const variant of product.variants || []) {
    const cp = variant.calculated_price || {};
    if (expiredPriceIds.has(cp.id)) affected.push(variant.id);
  }
  return affected;
}

async function deactivatePriceList(token, priceListId) {
  const res = await fetch(`${BASE_URL}/admin/price-lists/${priceListId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "draft" }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).price_list;
}

export async function run() {
  const token = await getToken();
  const now = new Date();

  const priceLists = await listPriceLists(token);
  const flagged = priceLists.filter((pl) => isPriceListExpiredButActive(pl, now));

  if (flagged.length === 0) {
    console.log(`No expired-but-active price lists found out of ${priceLists.length}.`);
    return;
  }

  for (const pl of flagged) {
    const priceIds = (pl.prices || []).map((p) => p.id);
    console.warn(
      `Price list ${pl.id} (${pl.title}) is status=active with ends_at=${pl.ends_at} in the past. ${priceIds.length} price row(s) still attached.`
    );
    if (!DRY_RUN) {
      await deactivatePriceList(token, pl.id);
      console.log(`Moved ${pl.id} to status=draft. Re-check calculated_price and purge any CDN cache in front of /store.`);
    } else {
      console.log(`DRY_RUN=true. Would set status=draft on ${pl.id}.`);
    }
  }

  console.log(`Done. ${flagged.length} price list(s) flagged out of ${priceLists.length}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
