/**
 * Find Medusa v2 orders mislabeled partially_captured by a sub-cent BigNumber
 * remainder, and clear the false positive the safe way. Never writes
 * payment_collection.status directly, since it is computed by
 * getLastPaymentStatus on every read. DRY_RUN=true only logs the
 * order_id/payment_id pairs and the computed delta it would capture. Safe to
 * run again and again, because it only captures a delta strictly smaller
 * than one currency minor unit.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Number of decimal digits Medusa uses for each currency's minor unit.
// Extend this set for any other zero decimal currencies your store supports.
const ZERO_DECIMAL_CURRENCIES = new Set(["jpy", "krw", "vnd"]);

const ORDER_FIELDS =
  "id,display_id,status,payment_status,currency_code," +
  "*payment_collections," +
  "payment_collections.amount," +
  "payment_collections.captured_amount," +
  "payment_collections.status";

export function currencyDecimalDigits(currencyCode) {
  return ZERO_DECIMAL_CURRENCIES.has((currencyCode || "").toLowerCase()) ? 0 : 2;
}

export function classifyCaptureDelta(amount, capturedAmount, currencyDecimalDigits) {
  // Pure: no I/O. Returns delta, whether it looks like a rounding artifact,
  // and the action to take: "clear", "flag", or "none".
  const scale = 10 ** (currencyDecimalDigits + 4);
  const delta = Math.round((amount - capturedAmount) * scale) / scale;
  const minorUnit = 10 ** -currencyDecimalDigits;

  if (delta <= 0) return { delta, isRoundingArtifact: false, action: "none" };
  if (delta < minorUnit) return { delta, isRoundingArtifact: true, action: "clear" };
  return { delta, isRoundingArtifact: false, action: "flag" };
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listOrders(token) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = new URL(`${BASE_URL}/admin/orders`);
    url.searchParams.set("fields", ORDER_FIELDS);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    out.push(...body.orders);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function paymentIdsForCollection(token, orderId, collectionId) {
  // The list endpoint above does not expand nested payments, so fetch the
  // order once more with payments expanded only for collections we act on.
  const url = new URL(`${BASE_URL}/admin/orders/${orderId}`);
  url.searchParams.set("fields", "id,*payment_collections.payments");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  const pc = (body.order.payment_collections || []).find((c) => c.id === collectionId);
  return pc ? (pc.payments || []).map((p) => p.id).filter(Boolean) : [];
}

async function captureRemainder(token, paymentId, delta) {
  const res = await fetch(`${BASE_URL}/admin/payments/${paymentId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: delta }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function getOrder(token, orderId) {
  const url = new URL(`${BASE_URL}/admin/orders/${orderId}`);
  url.searchParams.set("fields", "id,payment_status,*payment_collections");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.order;
}

export async function run() {
  const token = await getToken();
  const orders = await listOrders(token);

  const toClear = [];
  const toFlag = [];
  for (const order of orders) {
    const digits = currencyDecimalDigits(order.currency_code);
    for (const pc of order.payment_collections || []) {
      if (pc.status !== "partially_captured") continue;
      const result = classifyCaptureDelta(pc.amount || 0, pc.captured_amount || 0, digits);
      if (result.action === "clear") toClear.push([order, pc, result]);
      else if (result.action === "flag") toFlag.push([order, pc, result]);
    }
  }

  for (const [order, pc, result] of toFlag) {
    console.warn(
      `Order ${order.id} collection ${pc.id}: delta ${result.delta} is a real outstanding balance, not rounding. Flagging for review.`
    );
  }

  if (toClear.length === 0) {
    console.log(`No rounding-artifact mislabels found across ${orders.length} order(s).`);
    return;
  }

  let cleared = 0;
  for (const [order, pc, result] of toClear) {
    const paymentIds = await paymentIdsForCollection(token, order.id, pc.id);
    if (paymentIds.length === 0) {
      console.warn(
        `Order ${order.id} collection ${pc.id} delta ${result.delta} looks like a rounding artifact but has no payment to capture against. Flagging for review.`
      );
      continue;
    }

    const paymentId = paymentIds[0];
    console.log(
      `Order ${order.id} payment ${paymentId}: delta ${result.delta} under one minor unit. ${DRY_RUN ? "Would capture remainder" : "Capturing remainder"}`
    );
    if (!DRY_RUN) await captureRemainder(token, paymentId, result.delta);
    cleared++;
  }

  if (!DRY_RUN) {
    for (const [order] of toClear) {
      const refreshed = await getOrder(token, order.id);
      console.log(`Order ${refreshed.id} payment_status is now ${refreshed.payment_status}.`);
    }
  }

  console.log(`Done. ${cleared} order(s) ${DRY_RUN ? "to clear" : "cleared"}. ${toFlag.length} flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
