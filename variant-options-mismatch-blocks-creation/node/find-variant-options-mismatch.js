/**
 * Find Medusa products whose variants have an options mismatch that would
 * block creation: a missing option title, an extra title, or an invalid value.
 * Report only. Never guesses or writes a variant's option value.
 * Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRODUCT_FIELDS =
  "id,title,*options,*options.values,*variants," +
  "*variants.options,*variants.options.option";

function normalizeVariantOptions(variant) {
  // Accepts either the expanded admin shape (a list of
  // { option: { title }, value }) or an already-flat { title: value }
  // map, and returns a plain { title: value } object either way.
  const raw = variant.options;
  if (raw && !Array.isArray(raw) && typeof raw === "object") return { ...raw };
  const flat = {};
  for (const entry of raw || []) {
    const title = entry.option && entry.option.title;
    if (title) flat[title] = entry.value;
  }
  return flat;
}

export function findIncompleteVariants(product) {
  // Pure: no I/O. Returns a list of {variant_id, variant_title,
  // missing_titles, extra_titles, invalid_values} for every variant whose
  // normalized options do not exactly match the product's option set.
  const options = product.options || [];
  const requiredTitles = new Set(options.map((o) => o.title));
  const valuesByTitle = new Map(
    options.map((o) => [o.title, new Set((o.values || []).map((v) => v.value))])
  );

  const results = [];
  for (const variant of product.variants || []) {
    const variantOptions = normalizeVariantOptions(variant);
    const variantTitles = new Set(Object.keys(variantOptions));

    const missingTitles = [...requiredTitles].filter((t) => !variantTitles.has(t)).sort();
    const extraTitles = [...variantTitles].filter((t) => !requiredTitles.has(t)).sort();
    const invalidValues = [];
    for (const [title, value] of Object.entries(variantOptions)) {
      if (requiredTitles.has(title) && !(valuesByTitle.get(title) || new Set()).has(value)) {
        invalidValues.push({ title, value });
      }
    }

    if (missingTitles.length || extraTitles.length || invalidValues.length) {
      results.push({
        variant_id: variant.id,
        variant_title: variant.title,
        missing_titles: missingTitles,
        extra_titles: extraTitles,
        invalid_values: invalidValues,
      });
    }
  }
  return results;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function* listProducts(sdk, limit = 100) {
  let offset = 0;
  while (true) {
    const body = await sdk.admin.product.list({ fields: PRODUCT_FIELDS, limit, offset });
    for (const product of body.products) yield product;
    offset += limit;
    if (offset >= body.count) return;
  }
}

export async function run() {
  const sdk = await login();
  let flaggedProducts = 0;
  let flaggedVariants = 0;

  for await (const product of listProducts(sdk)) {
    const mismatches = findIncompleteVariants(product);
    if (mismatches.length === 0) continue;
    flaggedProducts += 1;
    for (const m of mismatches) {
      flaggedVariants += 1;
      console.log(
        `${DRY_RUN ? "Would flag" : "Flagging"} product ${product.id} (${product.title}) ` +
        `variant ${m.variant_id} (${m.variant_title}): ` +
        `missing=${JSON.stringify(m.missing_titles)} extra=${JSON.stringify(m.extra_titles)} ` +
        `invalid=${JSON.stringify(m.invalid_values)}`
      );
    }
  }

  console.log(
    `Done. ${flaggedProducts} product(s), ${flaggedVariants} variant(s) flagged for merchant follow-up.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
