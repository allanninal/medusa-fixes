/**
 * Detect Medusa v2 carts stuck at checkout because their items are stocked
 * across two or more stock locations, a known upstream bug (medusajs/medusa#10561).
 *
 * The confirm-inventory preparation step, prepare-confirm-inventory-input.ts, merges
 * every line item's valid stock locations into one flattened list instead of keeping
 * each item's valid locations scoped to itself. The reserve-inventory step then picks
 * the first location in that merged list and tries to reserve every item there, so an
 * item only stocked at a different location fails to reserve, even though the channel
 * has enough total stock. This lists a cart's items, computes each item's own valid
 * locations from real per-location stock, and flags the cart when no single location
 * covers every item, though each item has stock somewhere. Auto-repair is unsafe, since
 * Medusa v2 has no supported endpoint to force per-item reservation at cart completion,
 * so the only write here is an optional, DRY_RUN-guarded manual reservation per item at
 * its own correct location, meant as a one-off mitigation while you upgrade past the bug.
 *
 * Guide: https://www.allanninal.dev/medusa/checkout-blocked-multi-location-cart/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const CART_ID = (process.env.CART_ID || "").trim() || null;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ lineItemId: string, inventoryItemId: string, requiredQty: number }[]} items
 * @param {Record<string, { locationId: string, stockedQuantity: number, reservedQuantity: number }[]>} levelsByInventoryItem
 * @param {string[]} channelLocationIds
 * @returns {{ lineItemId: string, validLocationIds: string[] }[]}
 */
export function resolveItemLocations(items, levelsByInventoryItem, channelLocationIds) {
  const channelSet = new Set(channelLocationIds);
  return items.map((item) => {
    const levels = levelsByInventoryItem[item.inventoryItemId] || [];
    const validLocationIds = levels
      .filter(
        (lvl) =>
          channelSet.has(lvl.locationId) &&
          lvl.stockedQuantity - lvl.reservedQuantity >= item.requiredQty
      )
      .map((lvl) => lvl.locationId);
    return { lineItemId: item.lineItemId, validLocationIds };
  });
}

/**
 * Pure decision function. No I/O.
 *
 * A cart is a stuck-at-reservation candidate when every item has at least one valid
 * location of its own, but no single location is valid for every item at once, the
 * signature of medusajs/medusa#10561.
 *
 * @param {{ lineItemId: string, validLocationIds: string[] }[]} itemLocations
 * @returns {boolean}
 */
export function isAffectedCart(itemLocations) {
  if (!itemLocations.length) return false;
  if (itemLocations.some((entry) => entry.validLocationIds.length === 0)) return false;
  const shared = itemLocations.reduce(
    (acc, entry) => new Set([...acc].filter((id) => entry.validLocationIds.includes(id))),
    new Set(itemLocations[0].validLocationIds)
  );
  return shared.size === 0;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getChannelLocationIds(sdk, salesChannelId) {
  const { sales_channel } = await sdk.admin.salesChannel.retrieve(salesChannelId, {
    fields: "id,*stock_locations",
  });
  return sales_channel.stock_locations.map((loc) => loc.id);
}

async function getCart(sdk, cartId) {
  const { cart } = await sdk.store.cart.retrieve(cartId, {
    fields: "id,sales_channel_id,*items,items.variant",
  });
  return cart;
}

async function getVariantInventoryItemId(sdk, productId, variantId) {
  const { variant } = await sdk.admin.product.retrieveVariant(productId, variantId, {
    fields: "id,*inventory_items,inventory_items.inventory.id",
  });
  const items = variant.inventory_items;
  return items.length ? items[0].inventory.id : null;
}

async function getLocationLevels(sdk, inventoryItemId) {
  const { inventory_levels } = await sdk.admin.inventoryItem.listLocationLevels(inventoryItemId, {
    fields: "location_id,stocked_quantity,reserved_quantity",
  });
  return inventory_levels.map((lvl) => ({
    locationId: lvl.location_id,
    stockedQuantity: lvl.stocked_quantity,
    reservedQuantity: lvl.reserved_quantity,
  }));
}

async function hasReservation(sdk, lineItemId) {
  const { reservations } = await sdk.admin.reservation.list({ line_item_id: lineItemId });
  return reservations.length > 0;
}

async function createReservation(sdk, payload) {
  return sdk.admin.reservation.create(payload);
}

export async function run() {
  if (!CART_ID) throw new Error("Set CART_ID to the cart you want to check.");

  const sdk = await getSdk();
  const cart = await getCart(sdk, CART_ID);
  const channelLocationIds = await getChannelLocationIds(sdk, cart.sales_channel_id);

  const items = [];
  const inventoryItemByLineItem = new Map();
  for (const lineItem of cart.items) {
    const variant = lineItem.variant;
    const inventoryItemId = await getVariantInventoryItemId(sdk, variant.product_id, variant.id);
    if (!inventoryItemId) continue;
    items.push({ lineItemId: lineItem.id, inventoryItemId, requiredQty: lineItem.quantity });
    inventoryItemByLineItem.set(lineItem.id, inventoryItemId);
  }

  const levelsByInventoryItem = {};
  for (const item of items) {
    levelsByInventoryItem[item.inventoryItemId] = await getLocationLevels(sdk, item.inventoryItemId);
  }

  const itemLocations = resolveItemLocations(items, levelsByInventoryItem, channelLocationIds);
  const affected = isAffectedCart(itemLocations);

  if (!affected) {
    console.log(`Cart ${CART_ID}: not affected. Items share a common valid location, or one has none at all.`);
    return;
  }

  const unreserved = [];
  for (const entry of itemLocations) {
    if (!(await hasReservation(sdk, entry.lineItemId))) unreserved.push(entry);
  }

  console.warn(
    `Cart ${CART_ID} is affected by medusajs/medusa#10561: no shared location across items, ${unreserved.length} item(s) missing a reservation.`
  );
  for (const entry of itemLocations) {
    console.log(`  line item ${entry.lineItemId} valid locations: ${JSON.stringify(entry.validLocationIds)}`);
  }

  for (const entry of unreserved) {
    const locationId = entry.validLocationIds[0];
    const inventoryItemId = inventoryItemByLineItem.get(entry.lineItemId);
    const requiredQty = items.find((i) => i.lineItemId === entry.lineItemId).requiredQty;
    const payload = {
      line_item_id: entry.lineItemId,
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      quantity: requiredQty,
    };
    console.log(`${DRY_RUN ? "Would create" : "Creating"} reservation: ${JSON.stringify(payload)}`);
    if (!DRY_RUN) await createReservation(sdk, payload);
  }

  console.log(`Done. ${unreserved.length} item(s) ${DRY_RUN ? "would need" : "given"} a manual reservation.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
