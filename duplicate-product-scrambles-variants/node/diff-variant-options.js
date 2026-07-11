/**
 * Find Medusa variants whose option pairing got scrambled by product duplication.
 *
 * Medusa links a ProductVariant to its options by title to value pairing, for
 * example options: {"Size": "Small", "Color": "Red"}, not by a stable
 * positional index. When a product is duplicated, its ProductOption and
 * ProductOptionValue rows are recreated on the copy with brand new ids, and
 * the duplication step re-attaches each new variant to that new set. If that
 * re-attachment happens by creation order instead of by matching each source
 * variant's actual title and value pairing, a variant in the duplicate can
 * land on the wrong value even though the variant count and SKUs still look
 * correct.
 *
 * This fetches the source product and the duplicate product, normalizes every
 * variant's options into a canonical signature string with a pure function,
 * and reports every duplicate variant whose signature does not match its
 * source counterpart. It never writes to the option or option value tables
 * directly. The only write this script can make is correcting a mismatched
 * variant's options through the existing variant update route, and it only
 * does that when DRY_RUN is explicitly set to false. Run once per source and
 * duplicate pair.
 *
 * Guide: https://www.allanninal.dev/medusa/duplicate-product-scrambles-variants/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const FIELDS = "id,title,*options,*options.values,*variants,*variants.sku,*variants.options,*variants.options.option";

export function normalizeVariants(product) {
  const variants = product.variants || [];
  return variants.map((v) => {
    const pairs = (v.options || [])
      .map((opt) => ({ title: opt.option?.title, value: opt.value }))
      .filter((p) => p.title != null && p.value != null);
    return { sku: v.sku, options: pairs };
  });
}

function signature(options) {
  const pairs = [...options].sort((a, b) => a.title.localeCompare(b.title));
  return pairs.map((p) => `${p.title}:${p.value}`).join("|");
}

export function diffVariantOptionSignatures(sourceVariants, dupVariants) {
  const hasDupSkus = sourceVariants.length && dupVariants.length &&
    sourceVariants.every((v) => v.sku) && dupVariants.every((v) => v.sku) &&
    new Set(sourceVariants.map((v) => v.sku)).size === sourceVariants.length &&
    new Set(dupVariants.map((v) => v.sku)).size === dupVariants.length;

  const mismatches = [];

  if (!hasDupSkus) {
    const len = Math.min(sourceVariants.length, dupVariants.length);
    for (let i = 0; i < len; i++) {
      const src = sourceVariants[i];
      const dup = dupVariants[i];
      const expected = signature(src.options);
      const actual = signature(dup.options);
      if (expected !== actual) {
        mismatches.push({ sku: dup.sku || src.sku || `#${i}`, expected, actual });
      }
    }
    return mismatches;
  }

  const bySku = new Map(dupVariants.map((v) => [v.sku, v]));
  for (const src of sourceVariants) {
    const dup = bySku.get(src.sku);
    if (!dup) continue;
    const expected = signature(src.options);
    const actual = signature(dup.options);
    if (expected !== actual) {
      mismatches.push({ sku: src.sku, expected, actual });
    }
  }
  return mismatches;
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/admin/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function getProduct(token, productId) {
  const url = new URL(`${BACKEND_URL}/admin/products/${productId}`);
  url.searchParams.set("fields", FIELDS);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.product;
}

async function fixVariantOptions(token, productId, variantId, optionsMap) {
  const res = await fetch(`${BACKEND_URL}/admin/products/${productId}/variants/${variantId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ options: optionsMap }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.product;
}

export async function run(sourceProductId, duplicateProductId) {
  sourceProductId = sourceProductId || process.env.SOURCE_PRODUCT_ID;
  duplicateProductId = duplicateProductId || process.env.DUPLICATE_PRODUCT_ID;

  const token = await getAdminToken();
  const source = await getProduct(token, sourceProductId);
  const duplicate = await getProduct(token, duplicateProductId);

  const sourceVariants = normalizeVariants(source);
  const dupVariants = normalizeVariants(duplicate);
  const mismatches = diffVariantOptionSignatures(sourceVariants, dupVariants);

  if (mismatches.length === 0) {
    console.log(`Done. No scrambled variants found between ${sourceProductId} and ${duplicateProductId}.`);
    return;
  }

  console.log(`Found ${mismatches.length} scrambled variant(s) on duplicate ${duplicateProductId}.`);
  const dupVariantBySku = new Map((duplicate.variants || []).map((v) => [v.sku, v]));
  for (const m of mismatches) {
    console.log(`  sku=${m.sku} expected="${m.expected}" actual="${m.actual}"`);

    if (!DRY_RUN) {
      const variant = dupVariantBySku.get(m.sku);
      if (!variant) continue;
      const optionsMap = Object.fromEntries(
        m.expected.split("|").filter(Boolean).map((pair) => pair.split(":"))
      );
      console.log(`  Fixing variant ${variant.id} to ${JSON.stringify(optionsMap)}`);
      await fixVariantOptions(token, duplicateProductId, variant.id, optionsMap);
    } else {
      console.log("  Would fix this variant to match the expected signature.");
    }
  }

  console.log(`Done. ${mismatches.length} scrambled variant(s) ${DRY_RUN ? "to fix" : "fixed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
