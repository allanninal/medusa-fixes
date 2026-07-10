/**
 * Find Medusa v2 variants that can sell forever because inventory is not managed.
 *
 * Every ProductVariant has a manage_inventory flag. When it is not exactly true,
 * Medusa's cart and checkout workflows skip the Inventory Module entirely, so the
 * variant is always treated as available no matter how much real stock exists.
 * This script lists every product's variants, classifies each one, and reports
 * every variant that is an oversell risk. It only reports by default. Flipping
 * manage_inventory on and setting a stock count is a separate, human-approved
 * step behind DRY_RUN, because some variants (digital goods, services, gift
 * cards) are deliberately left untracked.
 *
 * Guide: https://www.allanninal.dev/medusa/inventory-not-managed-never-sells-out/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DEFAULT_EXEMPT_TAGS = ["digital", "service", "gift-card"];

const PRODUCT_FIELDS =
  "id,title,status,tags,*variants,variants.manage_inventory,variants.sku," +
  "*variants.inventory_items,*variants.inventory_items.inventory," +
  "*variants.inventory_items.inventory.location_levels";

function hasStock(inventoryItem) {
  const levels = inventoryItem.inventory?.location_levels || [];
  return levels.some((lvl) => (lvl.stocked_quantity || 0) > 0);
}

export function classifyVariantInventoryRisk(variant, exemptTags = DEFAULT_EXEMPT_TAGS) {
  const tags = variant.product_tags || [];
  if (tags.some((tag) => exemptTags.includes(tag))) return "exempt";
  if (variant.manage_inventory !== true) return "unmanaged_risk";
  const items = variant.inventory_items || [];
  if (items.length === 0 || !items.some(hasStock)) return "managed_but_untracked";
  return "ok";
}

function variantRecords(product) {
  const tags = (product.tags || []).map((t) => t.value).filter(Boolean);
  return (product.variants || []).map((variant) => ({
    id: variant.id,
    sku: variant.sku,
    manage_inventory: variant.manage_inventory,
    inventory_items: variant.inventory_items || [],
    product_tags: tags,
    product_id: product.id,
    product_title: product.title,
  }));
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function* listProducts(sdk) {
  const limit = 100;
  let offset = 0;
  while (true) {
    const body = await sdk.admin.product.list({
      fields: PRODUCT_FIELDS,
      limit,
      offset,
    });
    for (const product of body.products) yield product;
    offset += limit;
    if (offset >= body.count) return;
  }
}

// Only called when DRY_RUN is false and a human confirmed this variant.
async function enableManageInventory(sdk, productId, variantId) {
  return sdk.admin.product.updateVariant(productId, variantId, {
    manage_inventory: true,
  });
}

// Only called when DRY_RUN is false and a human supplied stockedQuantity.
async function ensureLocationLevel(sdk, inventoryItemId, locationId, stockedQuantity) {
  const { inventory_levels: levels } = await sdk.admin.inventoryItem.listLocationLevels(
    inventoryItemId
  );
  if (levels && levels.length) return levels;
  return sdk.admin.inventoryItem.createLocationLevel(inventoryItemId, {
    location_id: locationId,
    stocked_quantity: stockedQuantity,
  });
}

export async function run() {
  const sdk = await getSdk();
  let flagged = 0;
  for await (const product of listProducts(sdk)) {
    for (const variant of variantRecords(product)) {
      const risk = classifyVariantInventoryRisk(variant);
      if (risk === "ok" || risk === "exempt") continue;
      console.warn(
        `Product ${variant.product_title} variant ${variant.id} (sku=${variant.sku}) manage_inventory=${variant.manage_inventory} inventory_items=${variant.inventory_items.length} risk=${risk}`
      );
      flagged++;
    }
  }
  console.log(`Done. ${flagged} variant(s) ${DRY_RUN ? "flagged" : "flagged (dry run off, no auto-fix wired in)"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
