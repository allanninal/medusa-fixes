/**
 * Find Medusa variants with manage_inventory false whose stocked_quantity has
 * still drifted from a saved baseline (untracked stock that should never
 * change, but does). Report only, never auto-writes a corrected quantity.
 *
 * Guide: https://www.allanninal.dev/medusa/untracked-variant-quantity-drift/
 *
 * Safe to run again and again.
 */
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const BASELINE_PATH = process.env.BASELINE_PATH || "untracked_drift_baseline.json";

const PRODUCT_FIELDS = [
  "id,title,*variants,variants.manage_inventory,",
  "variants.inventory_items.inventory.id,",
  "variants.inventory_items.inventory.location_levels.stocked_quantity,",
  "variants.inventory_items.inventory.location_levels.reserved_quantity,",
  "variants.inventory_items.inventory.location_levels.location_id",
].join("");

export function detectUntrackedQuantityDrift(variants, baseline) {
  // Pure: no I/O. variants is [{ variantId, manageInventory, inventoryItemId,
  // locationLevels: [{ locationId, stockedQuantity }] }]. baseline is a Map of
  // inventoryItemId -> Map of locationId -> lastKnownStockedQuantity.
  //
  // Skips tracked variants (manageInventory true), skips variants with no
  // linked inventory item or no location levels, and only reports a record
  // when the delta between current and baseline quantity is nonzero, since
  // any change at all on a supposedly untracked variant is suspect.
  const drifted = [];
  for (const variant of variants) {
    if (variant.manageInventory) continue;
    const itemId = variant.inventoryItemId;
    const levels = variant.locationLevels || [];
    if (!itemId || levels.length === 0) continue;

    const itemBaseline = baseline.get(itemId);
    if (!itemBaseline) continue;

    for (const level of levels) {
      const { locationId, stockedQuantity: current } = level;
      if (!itemBaseline.has(locationId)) continue;
      const baselineQuantity = itemBaseline.get(locationId);
      const delta = current - baselineQuantity;
      if (delta !== 0) {
        drifted.push({
          variantId: variant.variantId,
          inventoryItemId: itemId,
          locationId,
          baselineQuantity,
          currentQuantity: current,
          delta,
        });
      }
    }
  }
  return drifted;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listProducts(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.product.list({ fields: PRODUCT_FIELDS, limit, offset });
    out.push(...body.products);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

function flattenVariants(products) {
  const flat = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      const inventoryItems = variant.inventory_items || [];
      const firstItem = inventoryItems[0]?.inventory || null;
      const itemId = firstItem?.id || null;
      const levels = (firstItem?.location_levels || []).map((lvl) => ({
        locationId: lvl.location_id,
        stockedQuantity: lvl.stocked_quantity,
      }));
      flat.push({
        variantId: variant.id,
        sku: variant.sku,
        productTitle: product.title,
        manageInventory: Boolean(variant.manage_inventory),
        inventoryItemId: itemId,
        locationLevels: levels,
      });
    }
  }
  return flat;
}

function loadBaseline(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
  const baseline = new Map();
  for (const [itemId, locs] of Object.entries(raw)) {
    baseline.set(itemId, new Map(Object.entries(locs)));
  }
  return baseline;
}

function saveBaseline(path, variants) {
  const snapshot = {};
  for (const variant of variants) {
    const itemId = variant.inventoryItemId;
    if (!itemId) continue;
    const locs = (snapshot[itemId] ||= {});
    for (const level of variant.locationLevels || []) {
      locs[level.locationId] = level.stockedQuantity;
    }
  }
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

async function restoreBaselineQuantity(sdk, inventoryItemId, locationId, baselineQuantity) {
  return sdk.admin.inventoryItem.updateLocationLevel(inventoryItemId, locationId, {
    stocked_quantity: baselineQuantity,
  });
}

export async function run() {
  // An operator can pass --restore=VARIANT_ID=QTY to approve a specific
  // restore. Nothing is ever inferred automatically.
  const restoreMap = new Map();
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--restore=")) {
      const pair = arg.slice("--restore=".length);
      const [variantId, qty] = pair.split("=");
      restoreMap.set(variantId, Number(qty));
    }
  }

  const sdk = await login();
  const products = await listProducts(sdk);
  const variants = flattenVariants(products);

  const baseline = loadBaseline(BASELINE_PATH);
  const drift = detectUntrackedQuantityDrift(variants, baseline);

  if (drift.length === 0) {
    console.log(`No drift found across ${variants.length} variant(s).`);
  } else {
    for (const record of drift) {
      console.warn(
        `Drift: variant ${record.variantId}, inventory_item ${record.inventoryItemId}, ` +
        `location ${record.locationId}. baseline=${record.baselineQuantity} ` +
        `current=${record.currentQuantity} delta=${record.delta}`
      );
    }
    console.log(`Done. ${drift.length} drifted record(s) found.`);
  }

  if (!DRY_RUN && restoreMap.size > 0) {
    const byVariant = new Map(variants.map((v) => [v.variantId, v]));
    for (const [variantId, targetQty] of restoreMap) {
      const variant = byVariant.get(variantId);
      if (!variant || !variant.inventoryItemId) {
        console.warn(`Skipping restore for ${variantId}, variant or inventory item not found.`);
        continue;
      }
      for (const level of variant.locationLevels) {
        console.log(
          `Restoring variant ${variantId} location ${level.locationId} from ` +
          `${level.stockedQuantity} to operator-confirmed ${targetQty}.`
        );
        await restoreBaselineQuantity(sdk, variant.inventoryItemId, level.locationId, targetQty);
      }
    }
  }

  saveBaseline(BASELINE_PATH, variants);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
