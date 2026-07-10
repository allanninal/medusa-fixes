/**
 * Audit Medusa price lists for why they are not applied at checkout.
 * Reports mismatches (draft, scheduled, expired, or missing currency/region price).
 * Never mutates merchant pricing data. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,type,*prices,*prices.price_rules,*rules";

export function getPriceListEffectiveState(priceList, now) {
  // Draft always wins regardless of dates, a draft list is never live.
  if (priceList.status === "draft") return "draft";

  const startsAt = priceList.starts_at ? new Date(priceList.starts_at) : null;
  const endsAt = priceList.ends_at ? new Date(priceList.ends_at) : null;

  if (startsAt && now < startsAt) return "scheduled"; // not started yet, full price still shown
  if (endsAt && now > endsAt) return "expired";        // window closed, full price still shown

  return "active"; // status is active AND now falls within [starts_at, ends_at]
}

export function hasMatchingPrice(prices, context) {
  return (prices || []).some((p) =>
    p.currency_code === context.currency_code &&
    (!p.rules?.region_id || p.rules.region_id === context.region_id) &&
    (!p.rules?.customer_group_id || p.rules.customer_group_id === context.customer_group_id)
  );
}

function buildFixPayload(priceList, state) {
  if (state === "draft") return { status: "active" };
  if (state === "scheduled") return { starts_at: new Date().toISOString() };
  if (state === "expired") return { ends_at: null };
  return null;
}

export function audit(priceLists, regions, now) {
  // Pure: returns a list of report objects, one per mismatched price list.
  const reports = [];
  for (const pl of priceLists) {
    const state = getPriceListEffectiveState(pl, now);
    if (state !== "active") {
      reports.push({ priceListId: pl.id, title: pl.title, reason: state, fix: buildFixPayload(pl, state) });
      continue;
    }
    for (const region of regions) {
      const context = { currency_code: region.currency_code, region_id: region.id };
      if (!hasMatchingPrice(pl.prices, context)) {
        reports.push({
          priceListId: pl.id,
          title: pl.title,
          reason: "active-but-no-matching-currency/region-price",
          region: region.name,
          currencyCode: region.currency_code,
          fix: { currency_code: region.currency_code, rules: { region_id: region.id } },
        });
      }
    }
  }
  return reports;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listPriceLists(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.priceList.list({ fields: PRICE_LIST_FIELDS, limit, offset });
    out.push(...body.price_lists);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function listRegions(sdk) {
  const body = await sdk.admin.region.list({ fields: "id,name,currency_code", limit: 100 });
  return body.regions;
}

export async function run() {
  const sdk = await login();
  const priceLists = await listPriceLists(sdk);
  const regions = await listRegions(sdk);
  const now = new Date();

  const reports = audit(priceLists, regions, now);
  if (reports.length === 0) {
    console.log(`All ${priceLists.length} price list(s) are effectively active with full currency coverage.`);
    return;
  }

  for (const r of reports) {
    console.log(
      `Price list ${r.priceListId} (${r.title}): ${r.reason}. ${DRY_RUN ? "Would send" : "Suggested"} payload: ${JSON.stringify(r.fix)}`
    );
  }
  console.log(`Done. ${reports.length} price list(s) flagged out of ${priceLists.length}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
