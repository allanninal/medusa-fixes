/**
 * Find Medusa inventory levels where reserved quantity exceeds stocked
 * quantity (an oversold variant with negative available stock).
 * Never writes a location level without --confirm. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/oversold-variant-goes-negative/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ITEM_FIELDS = "id,sku,*location_levels,*location_levels.location";

/**
 * Pure decision logic (no I/O).
 *
 * level: { inventoryItemId, locationId, stockedQuantity, reservedQuantity, allowBackorder }
 * openReservationsTotal: sum of quantity across open reservations for this inventory
 *   item and location, used as a floor for the proposed recount.
 *
 * Returns { isOversold, available, reason, proposedStockedQuantity }.
 * Backorder-enabled variants are expected to go negative/zero by design, not a bug,
 * so they are never flagged.
 */
export function decideInventoryRepair(level, openReservationsTotal) {
  const { stockedQuantity: stocked, reservedQuantity: reserved, allowBackorder } = level;
  const available = stocked - reserved;

  const isOversold = (available < 0 || reserved > stocked) && !allowBackorder;

  if (!isOversold) {
    return { isOversold: false, available, reason: "ok", proposedStockedQuantity: null };
  }

  const reason = reserved > stocked ? "reserved_exceeds_stock" : "negative_available";
  // Guarantee available >= 0 without dropping below what open orders already reserved.
  const proposedStockedQuantity = Math.max(stocked, openReservationsTotal);
  return { isOversold: true, available, reason, proposedStockedQuantity };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listInventoryItems(sdk) {
  const out = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const body = await sdk.admin.inventoryItem.list({ fields: ITEM_FIELDS, limit, offset });
    out.push(...body.inventory_items);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function openReservationsTotal(sdk, inventoryItemId, locationId) {
  const out = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const body = await sdk.admin.reservation.list({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      limit,
      offset,
    });
    out.push(...body.reservations);
    offset += limit;
    if (offset >= body.count) break;
  }
  return out.reduce((sum, res) => sum + res.quantity, 0);
}

async function writeLocationLevel(sdk, inventoryItemId, locationId, realCount) {
  return sdk.admin.inventoryItem.updateLocationLevel(inventoryItemId, locationId, {
    stocked_quantity: realCount,
  });
}

export async function run() {
  const confirm = process.argv.includes("--confirm");
  const sdk = await login();
  const items = await listInventoryItems(sdk);

  let flagged = 0;
  for (const item of items) {
    for (const lvl of item.location_levels || []) {
      const level = {
        inventoryItemId: item.id,
        locationId: lvl.location_id,
        stockedQuantity: lvl.stocked_quantity,
        reservedQuantity: lvl.reserved_quantity,
        allowBackorder: Boolean(lvl.allow_backorder),
      };
      const reservedTotal = await openReservationsTotal(sdk, level.inventoryItemId, level.locationId);
      const decision = decideInventoryRepair(level, reservedTotal);
      if (!decision.isOversold) continue;

      flagged++;
      console.warn(
        `Inventory item ${item.id} (sku ${item.sku}) at location ${level.locationId}: ${decision.reason}. ` +
          `stocked=${level.stockedQuantity} reserved=${level.reservedQuantity} ` +
          `available=${decision.available} proposed realCount=${decision.proposedStockedQuantity}`
      );

      if (!DRY_RUN && confirm) {
        await writeLocationLevel(sdk, level.inventoryItemId, level.locationId, decision.proposedStockedQuantity);
        console.log(`Wrote stocked_quantity=${decision.proposedStockedQuantity} for item ${item.id} at location ${level.locationId}.`);
      }
    }
  }

  if (flagged === 0) {
    console.log(`No oversold inventory levels found across ${items.length} item(s).`);
    return;
  }

  if (DRY_RUN || !confirm) {
    console.log(`Done. ${flagged} level(s) flagged. Re-run with DRY_RUN=false and --confirm to write.`);
  } else {
    console.log(`Done. ${flagged} level(s) flagged and repaired.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
