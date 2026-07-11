/**
 * Flag Medusa v2 carts whose shipping promotion adjustment was computed against
 * a stale shipping amount, and safely repair by re-applying the same promotion
 * codes so Medusa's own updateCartPromotionsWorkflow recomputes it for real.
 * Never writes ShippingMethodAdjustment.amount directly. DRY_RUN=true only logs
 * stored vs expected. Safe to run again and again, one cart at a time.
 *
 * Guide: https://www.allanninal.dev/medusa/shipping-discount-stale-amount/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const TOLERANCE = 0.01;

const CART_FIELDS =
  "id,shipping_total,item_total," +
  "*shipping_methods,*shipping_methods.adjustments,*promotions";

export function computeExpectedShippingAdjustment(shippingMethod, promotion) {
  // Pure: no I/O. shippingMethod is { id, amount }.
  // promotion is { id, code, application_method: { type, value, target_type } }.
  // Returns null when the promotion does not target shipping methods.
  const app = promotion.application_method;
  if (app.target_type !== "shipping_methods") return null;
  const amount = shippingMethod.amount;
  const adjustmentAmount =
    app.type === "percentage" ? amount * (app.value / 100) : Math.min(app.value, amount);
  return { adjustment_amount: adjustmentAmount, is_stale: false, delta: 0 };
}

export function evaluateStaleAdjustment(shippingMethod, promotion, storedAmount) {
  // Pure: no I/O. Combines the expected amount with the persisted storedAmount
  // (read by the caller) to produce delta and is_stale.
  const expected = computeExpectedShippingAdjustment(shippingMethod, promotion);
  if (expected === null) return null;
  const delta = storedAmount - expected.adjustment_amount;
  expected.delta = delta;
  expected.is_stale = Math.abs(delta) > TOLERANCE;
  return expected;
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function getCart(token, cartId) {
  const url = new URL(`${BASE_URL}/store/carts/${cartId}`);
  url.searchParams.set("fields", CART_FIELDS);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-publishable-api-key": PUBLISHABLE_KEY,
    },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.cart;
}

async function getPromotion(token, promotionId) {
  const url = new URL(`${BASE_URL}/admin/promotions/${promotionId}`);
  url.searchParams.set(
    "fields",
    "id,code,application_method.value,application_method.target_type,application_method.type"
  );
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.promotion;
}

async function reapplyPromotions(token, cartId, promoCodes) {
  const res = await fetch(`${BASE_URL}/store/carts/${cartId}/promotions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-publishable-api-key": PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ promo_codes: promoCodes }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.cart;
}

async function findStaleShippingAdjustments(token, cartId) {
  const cart = await getCart(token, cartId);
  const promotionsByCode = new Map((cart.promotions || []).map((p) => [p.code, p]));
  const flagged = [];
  for (const method of cart.shipping_methods || []) {
    const shippingMethod = { id: method.id, amount: method.amount };
    for (const adj of method.adjustments || []) {
      const promo = promotionsByCode.get(adj.code);
      if (!promo) continue;
      const promotion = await getPromotion(token, promo.id);
      const result = evaluateStaleAdjustment(shippingMethod, promotion, adj.amount);
      if (!result || !result.is_stale) continue;
      flagged.push({
        cart_id: cartId,
        shipping_method_id: method.id,
        promotion_code: adj.code,
        stored_amount: adj.amount,
        expected_amount: result.adjustment_amount,
        delta: result.delta,
      });
    }
  }
  return { flagged, codes: [...promotionsByCode.keys()] };
}

export async function run(cartIds) {
  const token = await getToken();
  const ids = (cartIds || (process.env.CART_IDS || "").split(","))
    .map((c) => c.trim())
    .filter(Boolean);

  let totalFlagged = 0;
  for (const cartId of ids) {
    const { flagged, codes } = await findStaleShippingAdjustments(token, cartId);
    for (const f of flagged) {
      console.log(
        `Cart ${f.cart_id} shipping method ${f.shipping_method_id} promo ${f.promotion_code}: stored=${f.stored_amount} expected=${f.expected_amount} delta=${f.delta}. ${DRY_RUN ? "Would re-apply" : "Re-applying"}`
      );
      if (!DRY_RUN) await reapplyPromotions(token, cartId, codes);
      totalFlagged++;
    }
  }

  console.log(`Done. ${totalFlagged} stale shipping adjustment(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
