/**
 * Find Medusa variants that collide on barcode, ean, or upc after a product
 * duplication, safely.
 *
 * The admin Duplicate action clones a product by re-submitting its variants
 * through createProductsWorkflow and createProductVariantsWorkflow, the same
 * workflows used for a normal POST /admin/products, and it copies every
 * variant field verbatim, including sku, ean, upc, and barcode. The
 * product_variant table has unique partial indexes on those identifier
 * columns, scoped to deleted_at IS NULL, so a duplicated variant that carries
 * the same barcode as its source hits a Postgres unique constraint
 * violation. Medusa never auto-clears or regenerates these fields, so the
 * failure is deterministic, not a race condition, for any product whose
 * variants have a barcode-family value set.
 *
 * This lists every product's variants, groups their identifier fields with a
 * pure decision function, and reports every value shared by more than one
 * product. It never overwrites a barcode automatically. The only write this
 * script can make is clearing one confirmed field to null on one confirmed
 * variant id, and only when DRY_RUN is explicitly set to false. It never
 * invents a replacement value. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/duplicate-product-barcode-conflict/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRMED_VARIANT_ID = process.env.CONFIRMED_VARIANT_ID || "";
const CONFIRMED_FIELD = process.env.CONFIRMED_FIELD || "";

const FIELDS = ["barcode", "ean", "upc"];

export function findBarcodeConflicts(variants) {
  const groupsByField = { barcode: new Map(), ean: new Map(), upc: new Map() };

  for (const v of variants) {
    for (const field of FIELDS) {
      const value = v[field];
      if (value === null || value === undefined || value === "") continue;
      const bucket = groupsByField[field];
      if (!bucket.has(value)) bucket.set(value, []);
      bucket.get(value).push({ productId: v.productId, variantId: v.variantId });
    }
  }

  const conflicts = [];
  for (const field of FIELDS) {
    for (const [value, entries] of groupsByField[field]) {
      const productIds = new Set(entries.map((e) => e.productId));
      if (productIds.size > 1) conflicts.push({ field, value, entries });
    }
  }

  conflicts.sort((a, b) => (a.field === b.field ? (a.value < b.value ? -1 : a.value > b.value ? 1 : 0) : a.field.localeCompare(b.field)));
  return conflicts;
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listAllVariants(token) {
  const entries = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const url = new URL(`${BASE_URL}/admin/products`);
    url.searchParams.set("fields", "id,title,variants.id,variants.sku,variants.ean,variants.upc,variants.barcode");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa products ${res.status}`);
    const body = await res.json();
    for (const product of body.products) {
      for (const variant of product.variants || []) {
        entries.push({
          productId: product.id,
          variantId: variant.id,
          barcode: variant.barcode ?? null,
          ean: variant.ean ?? null,
          upc: variant.upc ?? null,
        });
      }
    }
    offset += limit;
    if (offset >= body.count) return entries;
  }
}

async function clearIdentifierField(token, productId, variantId, field) {
  const res = await fetch(`${BASE_URL}/admin/products/${productId}/variants/${variantId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: null }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.variant;
}

export async function run() {
  const token = await getToken();
  const variants = await listAllVariants(token);
  const conflicts = findBarcodeConflicts(variants);

  if (conflicts.length === 0) {
    console.log(`Done. No barcode, ean, or upc conflicts found across ${variants.length} variant(s).`);
    return;
  }

  console.log(`Found ${conflicts.length} conflict(s).`);
  for (const c of conflicts) {
    console.log(`Field ${c.field} value "${c.value}" shared by:`);
    for (const entry of c.entries) {
      console.log(`  product_id=${entry.productId} variant_id=${entry.variantId}`);
    }
  }

  if (CONFIRMED_VARIANT_ID && CONFIRMED_FIELD) {
    const target = conflicts.find(
      (c) => c.field === CONFIRMED_FIELD && c.entries.some((e) => e.variantId === CONFIRMED_VARIANT_ID)
    );
    if (!target) {
      console.warn(
        `CONFIRMED_VARIANT_ID ${CONFIRMED_VARIANT_ID} with field ${CONFIRMED_FIELD} was not found among the reported conflicts. Nothing cleared.`
      );
    } else {
      const productId = target.entries.find((e) => e.variantId === CONFIRMED_VARIANT_ID).productId;
      console.log(
        `${DRY_RUN ? "Would clear" : "Clearing"} field ${CONFIRMED_FIELD} on variant ${CONFIRMED_VARIANT_ID} (product ${productId})`
      );
      if (!DRY_RUN) await clearIdentifierField(token, productId, CONFIRMED_VARIANT_ID, CONFIRMED_FIELD);
    }
  }

  console.log(`Done. ${conflicts.length} conflict(s) reported.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
