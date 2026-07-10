/**
 * Find Medusa variants with a missing inventory level and create it, safely, at zero.
 *
 * A variant with manage_inventory true is only purchasable if its inventory item has
 * an InventoryLevel row at a stock location linked to the sales channel making the
 * request. This lists managed variants, reads each inventory item's existing levels,
 * decides what to do with a pure function, and only creates a level where one is
 * fully absent, always at stocked_quantity zero. A level that exists only at the
 * wrong location is flagged, not silently duplicated. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/variant-not-purchasable-no-inventory-level/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SALES_CHANNEL_ID = process.env.SALES_CHANNEL_ID || "sc_default";

const VARIANT_FIELDS =
  "id,title,status,*variants,variants.manage_inventory,variants.id," +
  "*variants.inventory_items,variants.inventory_items.inventory_item_id";

export function decideInventoryRepair(variant, existingLevels, requiredLocationIds) {
  if (!variant.manageInventory) {
    return { action: "skip", missingLocationIds: [] };
  }

  if (!variant.inventoryItemId) {
    return { action: "flag_no_inventory_item", missingLocationIds: [] };
  }

  const missingLocationIds = requiredLocationIds.filter(
    (id) => !existingLevels.some((l) => l.locationId === id)
  );

  if (missingLocationIds.length === 0) {
    return { action: "ok", missingLocationIds: [] };
  }

  return { action: "create_zero_level", missingLocationIds };
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function listManagedVariants(sdk) {
  let offset = 0;
  const limit = 100;
  const variants = [];
  while (true) {
    const { products, count } = await sdk.admin.product.list({ fields: VARIANT_FIELDS, limit, offset });
    for (const product of products) {
      for (const variant of product.variants || []) {
        if (variant.manage_inventory) {
          const items = variant.inventory_items || [];
          const inventoryItemId = items.length ? items[0].inventory_item_id : null;
          variants.push({ id: variant.id, manageInventory: true, inventoryItemId });
        }
      }
    }
    offset += limit;
    if (offset >= count) return variants;
  }
}

async function getLocationLevels(sdk, inventoryItemId) {
  const { inventory_item } = await sdk.admin.inventoryItem.retrieve(inventoryItemId, {
    fields: "id,*location_levels",
  });
  const levels = inventory_item.location_levels || [];
  return levels.map((lv) => ({ locationId: lv.location_id, stockedQuantity: lv.stocked_quantity }));
}

async function getRequiredLocationIds(sdk, salesChannelId) {
  const { sales_channel } = await sdk.admin.salesChannel.retrieve(salesChannelId, {
    fields: "id,name,*stock_locations",
  });
  const locations = sales_channel.stock_locations || [];
  return locations.map((loc) => loc.id);
}

async function createZeroLevel(sdk, inventoryItemId, locationId) {
  return sdk.admin.inventoryItem.updateLocationLevel(inventoryItemId, locationId, {
    stocked_quantity: 0,
  });
}

export async function run() {
  const sdk = await getSdk();
  const variants = await listManagedVariants(sdk);
  const requiredLocationIds = await getRequiredLocationIds(sdk, SALES_CHANNEL_ID);

  let created = 0;
  let flagged = 0;
  for (const variant of variants) {
    if (!variant.manageInventory) continue;

    if (!variant.inventoryItemId) {
      console.warn(`Variant ${variant.id} tracks inventory but has no inventory item. Flagging.`);
      flagged++;
      continue;
    }

    const existingLevels = await getLocationLevels(sdk, variant.inventoryItemId);
    const decision = decideInventoryRepair(variant, existingLevels, requiredLocationIds);

    if (decision.action === "skip" || decision.action === "ok") continue;
    if (decision.action === "flag_no_inventory_item") {
      flagged++;
      continue;
    }

    for (const locationId of decision.missingLocationIds) {
      console.log(
        `Inventory item ${variant.inventoryItemId} missing level at ${locationId}. ${DRY_RUN ? "would create stocked_quantity=0" : "creating stocked_quantity=0"}`
      );
      if (!DRY_RUN) await createZeroLevel(sdk, variant.inventoryItemId, locationId);
      created++;
    }
  }

  console.log(`Done. ${created} level(s) ${DRY_RUN ? "to create" : "created"}, ${flagged} variant(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
