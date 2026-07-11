/**
 * Repair Medusa variants whose CSV import never set a stocked quantity.
 *
 * In Medusa v2, stock lives on a location_levels record under a linked
 * inventory_item, in stocked_quantity, not on the variant itself.
 * importProductsWorkflow creates the inventory item for each variant, but
 * its CSV normalization step does not map the legacy Variant Inventory
 * Quantity column to a location level creation step, tracked upstream as
 * medusajs/medusa issues 11605 and 9357. Every imported variant can end up
 * with no location level, or one stuck at zero, no matter what the source
 * CSV said. This reads back the variants an import batch created, compares
 * each one's actual location levels against the source CSV row for its
 * SKU, and either logs or writes the missing stocked_quantity. Run once
 * after an import.
 *
 * Guide: https://www.allanninal.dev/medusa/csv-import-ignores-inventory-quantity/
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const BATCH_TAG = process.env.IMPORT_BATCH_TAG || "";
const CSV_PATH = process.env.IMPORT_CSV_PATH || "import.csv";
const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || "";

export function readCsvRowsBySku(csvPath) {
  const text = readFileSync(csvPath, "utf-8");
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",").map((h) => h.trim());
  const skuIdx = headers.indexOf("Variant SKU");
  const qtyIdx = headers.indexOf("Variant Inventory Quantity");
  const rows = {};
  for (const line of lines) {
    const cols = line.split(",");
    const sku = cols[skuIdx];
    const qty = Number(cols[qtyIdx] || "0");
    if (sku) rows[sku] = { sku, variantInventoryQuantity: qty };
  }
  return rows;
}

/**
 * Pure decision function. No I/O.
 *
 * csvRow: {sku: string, variantInventoryQuantity: number}
 * variant: {id: string, sku: string, inventoryItemId: string | null}
 * locationLevels: Array<{location_id: string, stocked_quantity: number}>
 * defaultLocationId: string
 *
 * Returns a repair action, or null if nothing needs to change:
 *   {action: "create_level" | "update_level", inventoryItemId: string,
 *    locationId: string, fromQty: number, toQty: number}
 */
export function decideInventoryRepair(csvRow, variant, locationLevels, defaultLocationId) {
  if ((csvRow.variantInventoryQuantity || 0) <= 0) return null;
  if (!variant.inventoryItemId) return null;

  if (!locationLevels.length) {
    return {
      action: "create_level",
      inventoryItemId: variant.inventoryItemId,
      locationId: defaultLocationId,
      fromQty: 0,
      toQty: csvRow.variantInventoryQuantity,
    };
  }

  const level = locationLevels.find((lvl) => lvl.location_id === defaultLocationId) || null;
  if (!level) {
    return {
      action: "create_level",
      inventoryItemId: variant.inventoryItemId,
      locationId: defaultLocationId,
      fromQty: 0,
      toQty: csvRow.variantInventoryQuantity,
    };
  }

  if ((level.stocked_quantity || 0) !== csvRow.variantInventoryQuantity) {
    return {
      action: "update_level",
      inventoryItemId: variant.inventoryItemId,
      locationId: defaultLocationId,
      fromQty: level.stocked_quantity || 0,
      toQty: csvRow.variantInventoryQuantity,
    };
  }

  return null;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getImportedProducts(sdk, batchTag) {
  const { products } = await sdk.admin.product.list({
    q: batchTag,
    fields: "id,title,*variants,*variants.inventory_items,*variants.inventory_items.inventory",
  });
  return products;
}

async function getLocationLevels(sdk, inventoryItemId) {
  const { inventory_levels } = await sdk.admin.inventoryItem.listLocationLevels(inventoryItemId, {
    fields: "location_id,stocked_quantity",
  });
  return inventory_levels;
}

async function createLocationLevel(sdk, inventoryItemId, locationId, stockedQuantity) {
  return sdk.admin.inventoryItem.createLocationLevel(inventoryItemId, {
    location_id: locationId,
    stocked_quantity: stockedQuantity,
  });
}

async function updateLocationLevel(sdk, inventoryItemId, locationId, stockedQuantity) {
  return sdk.admin.inventoryItem.updateLocationLevel(inventoryItemId, locationId, {
    stocked_quantity: stockedQuantity,
  });
}

export async function run() {
  if (!DEFAULT_LOCATION_ID) {
    throw new Error("Set DEFAULT_LOCATION_ID to the stock location the CSV quantity should land on.");
  }

  const sdk = await getSdk();
  const csvRows = readCsvRowsBySku(CSV_PATH);
  const products = await getImportedProducts(sdk, BATCH_TAG);

  let repaired = 0;
  let skippedNoInventoryItem = 0;

  for (const product of products) {
    for (const variant of product.variants || []) {
      const sku = variant.sku;
      const csvRow = csvRows[sku];
      if (!csvRow) continue;

      const inventoryItems = variant.inventory_items || [];
      const inventoryItemId = inventoryItems[0]?.inventory?.id || inventoryItems[0]?.inventory_item_id || null;

      const variantInput = { id: variant.id, sku, inventoryItemId };

      if (csvRow.variantInventoryQuantity > 0 && !inventoryItemId) {
        skippedNoInventoryItem++;
        console.warn(
          `Variant ${variant.id} (SKU ${sku}): CSV expected ${csvRow.variantInventoryQuantity} units but has no inventory item, flagging for manual review`
        );
        continue;
      }

      const locationLevels = inventoryItemId ? await getLocationLevels(sdk, inventoryItemId) : [];
      const decision = decideInventoryRepair(csvRow, variantInput, locationLevels, DEFAULT_LOCATION_ID);
      if (!decision) continue;

      console.log(
        `${DRY_RUN ? "Would repair" : "Repairing"} variant ${variant.id} (SKU ${sku}): location ${decision.locationId}, ${decision.fromQty} -> ${decision.toQty}`
      );

      if (!DRY_RUN) {
        if (decision.action === "create_level") {
          await createLocationLevel(sdk, decision.inventoryItemId, decision.locationId, decision.toQty);
        } else if (decision.action === "update_level") {
          await updateLocationLevel(sdk, decision.inventoryItemId, decision.locationId, decision.toQty);
        }
      }

      repaired++;
    }
  }

  console.log(
    `Done. ${repaired} variant(s) ${DRY_RUN ? "to repair" : "repaired"}, ${skippedNoInventoryItem} flagged with no inventory item.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
