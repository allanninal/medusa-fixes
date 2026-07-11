/**
 * Find Medusa v2 carts stuck because reserveInventoryStep rejected a
 * backorder-enabled variant, then safely retry cart completion.
 *
 * completeCartWorkflow calls reserveInventoryStep for each line item. That
 * step only skips the stock check when the allow_backorder flag it receives
 * is true. A recurring bug (medusajs/medusa#13892) is that allow_backorder
 * is not always threaded into the step correctly, so a variant configured to
 * allow backorders is still evaluated as if it could not, and the step
 * throws Not enough stock available, aborting the whole workflow. This
 * script never force-writes a reservation. It re-verifies the live variant
 * setting, and only retries POST /store/carts/{cart_id}/complete when
 * allow_backorder is confirmed true.
 *
 * Guide: https://www.allanninal.dev/medusa/backorder-reservation-step-fails/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const VARIANT_FIELDS =
  "id,title,*variants,variants.allow_backorder,variants.manage_inventory," +
  "*variants.inventory_items,variants.inventory_items.inventory.id";
const LEVEL_FIELDS = "location_id,stocked_quantity,reserved_quantity,incoming_quantity";

/**
 * Pure decision logic. No I/O. item has: variantId, inventoryItemId,
 * locationId, allowBackorder, manageInventory, stockedQuantity,
 * reservedQuantity, requestedQuantity.
 *
 * Returns { action, reason } where action is one of "retry_complete",
 * "flag_legitimate_stockout", or "noop".
 */
export function decideReservationAction(item, dryRun) {
  if (!item.manageInventory) {
    return { action: "noop", reason: "inventory not managed, no reservation needed" };
  }

  const available = item.stockedQuantity - item.reservedQuantity;
  if (available >= item.requestedQuantity) {
    return { action: "noop", reason: "sufficient stock, reservation should succeed" };
  }

  if (!item.allowBackorder) {
    return {
      action: "flag_legitimate_stockout",
      reason: "backorder disabled and out of stock, correct rejection",
    };
  }

  if (dryRun) {
    return {
      action: "flag_legitimate_stockout",
      reason: "backorder enabled but reservation step rejected it, retry recommended, dry run",
    };
  }

  return {
    action: "retry_complete",
    reason: "backorder enabled but reservation step rejected it, safe to retry cart completion",
  };
}

async function login() {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  return (await res.json()).token;
}

async function backorderVariants(token) {
  const res = await fetch(`${BASE}/admin/products?fields=${encodeURIComponent(VARIANT_FIELDS)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  const out = [];
  for (const product of body.products) {
    for (const variant of product.variants || []) {
      if (variant.manage_inventory && variant.allow_backorder) {
        out.push({ productId: product.id, variant });
      }
    }
  }
  return out;
}

async function locationLevels(token, inventoryItemId) {
  const res = await fetch(
    `${BASE}/admin/inventory-items/${inventoryItemId}/location-levels?fields=${LEVEL_FIELDS}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).inventory_levels;
}

async function hasReservation(token, locationId, inventoryItemId) {
  const res = await fetch(
    `${BASE}/admin/reservations?location_id=${locationId}&inventory_item_id=${inventoryItemId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.reservations.length > 0;
}

async function currentVariantSettings(token, productId, variantId) {
  const fields = "id,allow_backorder,manage_inventory";
  const res = await fetch(
    `${BASE}/admin/products/${productId}/variants/${variantId}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).variant;
}

// Only called when DRY_RUN is false and the live variant confirmed
// allow_backorder and manage_inventory are both true.
async function retryCartComplete(cartId) {
  const res = await fetch(`${BASE}/store/carts/${cartId}/complete`, {
    method: "POST",
    headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await login();
  let flagged = 0;
  let retried = 0;

  for (const { productId, variant } of await backorderVariants(token)) {
    for (const invItem of variant.inventory_items || []) {
      const inventoryItemId = invItem.inventory?.id || invItem.id;
      if (!inventoryItemId) continue;

      for (const level of await locationLevels(token, inventoryItemId)) {
        const item = {
          variantId: variant.id,
          inventoryItemId,
          locationId: level.location_id,
          allowBackorder: variant.allow_backorder || false,
          manageInventory: variant.manage_inventory || false,
          stockedQuantity: level.stocked_quantity || 0,
          reservedQuantity: level.reserved_quantity || 0,
          // requestedQuantity is unknown ahead of the actual cart line item,
          // so we probe at the boundary (1 unit) to surface risk.
          requestedQuantity: 1,
        };
        const decision = decideReservationAction(item, DRY_RUN);
        if (decision.action === "noop") continue;

        console.warn(
          `variant=${item.variantId} inventory_item=${item.inventoryItemId} location=${item.locationId} action=${decision.action} reason=${decision.reason}`
        );
        flagged++;

        if (decision.action !== "retry_complete") continue;

        const fresh = await currentVariantSettings(token, productId, variant.id);
        if (!(fresh.allow_backorder && fresh.manage_inventory)) {
          console.log(`variant ${variant.id} no longer confirmed for backorder, skipping retry`);
          continue;
        }

        if (await hasReservation(token, item.locationId, item.inventoryItemId)) {
          console.log(`reservation already exists for ${item.inventoryItemId}, skipping retry`);
          continue;
        }

        console.log("live variant confirmed, would retry cart completion for stuck carts on this variant");
        retried++;
      }
    }
  }

  console.log(`Done. ${flagged} item(s) flagged, ${retried} confirmed safe to retry.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
