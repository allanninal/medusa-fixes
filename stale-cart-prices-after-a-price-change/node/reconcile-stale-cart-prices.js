/**
 * Flag and safely repair Medusa v2 open carts still holding a stale unit_price
 * after a variant or price list change. Never touches is_custom_price line items,
 * never bulk overwrites. DRY_RUN=true only logs old vs new price. Safe to run
 * again and again, one cart at a time.
 *
 * Guide: https://www.allanninal.dev/medusa/stale-cart-prices-after-a-price-change/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CART_FIELDS =
  "id,updated_at,completed_at,currency_code,region_id," +
  "*line_items,line_items.unit_price,line_items.is_custom_price," +
  "line_items.variant_id,line_items.updated_at";

export function findStaleCartLineItems(carts, livePrices) {
  // Pure: no I/O. carts is an array of open cart objects with line_items.
  // livePrices is a Map keyed by `${variant_id}:${currency_code}:${region_id}`.
  const flagged = [];
  for (const cart of carts) {
    if (cart.completed_at !== null) continue;
    for (const item of cart.line_items || []) {
      if (item.is_custom_price) continue;
      const key = `${item.variant_id}:${cart.currency_code}:${cart.region_id}`;
      const live = livePrices.get(key);
      if (!live) continue;
      if (live.amount === item.unit_price) continue;
      if (item.updated_at >= live.updated_at) continue;
      flagged.push({
        cart_id: cart.id,
        line_item_id: item.id,
        old_price: item.unit_price,
        new_price: live.amount,
      });
    }
  }
  return flagged;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listOpenCarts(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.cart.list({ fields: CART_FIELDS, limit, offset });
    out.push(...body.carts.filter((c) => c.completed_at == null));
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function getVariantPrices(sdk, productId, variantId) {
  const body = await sdk.admin.product.retrieveVariant(productId, variantId, { fields: "id,*prices" });
  return body.variant.prices;
}

async function buildLivePriceMap(sdk, variantProductPairs, nowIso) {
  const livePrices = new Map();
  for (const [variantId, productId] of variantProductPairs) {
    const prices = await getVariantPrices(sdk, productId, variantId);
    for (const p of prices) {
      const regionId = p.rules?.region_id ?? null;
      const key = `${variantId}:${p.currency_code}:${regionId}`;
      livePrices.set(key, {
        amount: p.amount,
        currency_code: p.currency_code,
        region_id: regionId,
        updated_at: nowIso,
      });
    }
  }
  return livePrices;
}

async function forceRecompute(sdk, cartId, lineItemId) {
  return sdk.admin.cart.updateLineItem(cartId, lineItemId, {});
}

async function getCart(sdk, cartId) {
  const body = await sdk.admin.cart.retrieve(cartId, { fields: CART_FIELDS });
  return body.cart;
}

export async function run() {
  const sdk = await login();
  const carts = await listOpenCarts(sdk);

  const variantProductPairs = new Set();
  const pairsList = [];
  for (const cart of carts) {
    for (const item of cart.line_items || []) {
      if (item.product_id) {
        const key = `${item.variant_id}:${item.product_id}`;
        if (!variantProductPairs.has(key)) {
          variantProductPairs.add(key);
          pairsList.push([item.variant_id, item.product_id]);
        }
      }
    }
  }

  const nowIso = new Date().toISOString();
  const livePrices = await buildLivePriceMap(sdk, pairsList, nowIso);

  const flagged = findStaleCartLineItems(carts, livePrices);
  if (flagged.length === 0) {
    console.log(`No stale cart line items found across ${carts.length} open cart(s).`);
    return;
  }

  for (const f of flagged) {
    console.log(
      `Cart ${f.cart_id} line item ${f.line_item_id}: old_price=${f.old_price} new_price=${f.new_price}. ${DRY_RUN ? "Would repair" : "Repairing"}`
    );
    if (!DRY_RUN) {
      await forceRecompute(sdk, f.cart_id, f.line_item_id);
      const refreshed = await getCart(sdk, f.cart_id);
      const confirmed = (refreshed.line_items || []).some(
        (li) => li.id === f.line_item_id && li.unit_price === f.new_price
      );
      console.log(`Cart ${f.cart_id} line item ${f.line_item_id} confirmed: ${confirmed}`);
    }
  }

  console.log(`Done. ${flagged.length} stale line item(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
