/**
 * Flag and safely repair Medusa buyget promotions whose application_method
 * is structurally invalid, which makes computeActions silently return zero
 * adjustments on every cart update. Never rewrites a live promotion unless
 * DRY_RUN is explicitly false. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/buyget-promotion-not-applied-on-update/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PROMOTION_FIELDS =
  "id,code,type,status,is_automatic,*application_method," +
  "*application_method.target_rules,*application_method.buy_rules";

/**
 * Pure: no I/O. Takes an application_method object and returns
 * { valid, reasons }. Adds one reason for each of: target_rules empty,
 * buy_rules empty, buy_rules_min_quantity missing or not positive,
 * target_type === "order", allocation not in ["across", "each"],
 * apply_to_quantity missing, or (allocation === "each" and max_quantity
 * missing). valid is true only when reasons is empty. Mirrors the exact
 * shape the buyget engine requires to ever produce a computeActions
 * adjustment.
 */
export function isBuygetApplicationMethodValid(am) {
  const reasons = [];
  if (!(am.target_rules || []).length) reasons.push("target_rules is empty");
  if (!(am.buy_rules || []).length) reasons.push("buy_rules is empty");
  const minQty = am.buy_rules_min_quantity;
  if (minQty === null || minQty === undefined || minQty <= 0) {
    reasons.push("buy_rules_min_quantity is missing or not positive");
  }
  if (am.target_type === "order") reasons.push('target_type "order" is not supported for buyget');
  if (!["across", "each"].includes(am.allocation)) reasons.push("allocation must be across or each");
  if (am.apply_to_quantity === null || am.apply_to_quantity === undefined) {
    reasons.push("apply_to_quantity is missing");
  }
  if (am.allocation === "each" && (am.max_quantity === null || am.max_quantity === undefined)) {
    reasons.push("max_quantity is required when allocation is each");
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Pure: computes the corrected application_method payload for a flagged
 * promotion. Keeps the existing buy_rules and target_rules (a human
 * authored what should discount what), forces a supported target_type,
 * and fills in the missing quantity fields.
 */
export function buildCorrectedApplicationMethod(am) {
  const allocation = ["across", "each"].includes(am.allocation) ? am.allocation : "across";
  const corrected = {
    id: am.id,
    target_type: "items",
    allocation,
    apply_to_quantity: am.apply_to_quantity || am.buy_rules_min_quantity || 1,
    target_rules: am.target_rules || [],
    buy_rules: am.buy_rules || [],
  };
  if (allocation === "each") {
    corrected.max_quantity = am.max_quantity || corrected.apply_to_quantity;
  }
  return corrected;
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

async function listBuygetPromotions(token) {
  const url = new URL(`${BASE_URL}/admin/promotions`);
  url.searchParams.set("fields", PROMOTION_FIELDS);
  url.searchParams.set("type", "buyget");
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.promotions;
}

async function patchApplicationMethod(token, promotionId, corrected) {
  const res = await fetch(`${BASE_URL}/admin/promotions/${promotionId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ application_method: corrected }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.promotion;
}

async function findOpenCartsWithCode(token, code) {
  const url = new URL(`${BASE_URL}/admin/carts`);
  url.searchParams.set("fields", "id,*promotions,*items,*items.adjustments");
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  const carts = body.carts || [];
  return carts
    .filter((cart) => (cart.promotions || []).some((p) => p.code === code))
    .map((cart) => {
      const hasAdjustment = (cart.items || []).some((item) => (item.adjustments || []).length > 0);
      return { cartId: cart.id, hasAdjustment };
    });
}

/**
 * Re-triggers Medusa's own updateCartPromotionsWorkflow by re-sending the
 * same promo codes to the storefront cart promotions endpoint, so any
 * resulting adjustment comes from Medusa's engine, never injected by hand.
 * Requires a store publishable API key in practice; left as a thin helper
 * so the write path stays out of run()'s core loop.
 */
async function recomputeCartPromotions(token, cartId, promoCodes) {
  const res = await fetch(`${BASE_URL}/store/carts/${cartId}/promotions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ promo_codes: promoCodes }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.cart;
}

export async function run() {
  const token = await getToken();
  const promotions = await listBuygetPromotions(token);

  let flagged = 0;
  for (const promo of promotions) {
    const am = promo.application_method || {};
    const result = isBuygetApplicationMethodValid(am);
    if (result.valid) continue;

    flagged++;
    const corrected = buildCorrectedApplicationMethod(am);
    const affectedCarts = await findOpenCartsWithCode(token, promo.code);
    console.warn(
      `Promotion ${promo.id} (${promo.code}) invalid: ${result.reasons.join("; ")}. ${affectedCarts.length} open cart(s) reference this code.`
    );
    console.log(
      `${DRY_RUN ? "Would apply" : "Applying"} application_method diff: before=${JSON.stringify(am)} after=${JSON.stringify(corrected)}`
    );

    if (!DRY_RUN) {
      await patchApplicationMethod(token, promo.id, corrected);
      console.log(`Patched promotion ${promo.id}. Re-run cart promotions to verify adjustments.`);
    }
  }

  console.log(`Done. ${flagged} buyget promotion(s) ${DRY_RUN ? "flagged" : "flagged and repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
