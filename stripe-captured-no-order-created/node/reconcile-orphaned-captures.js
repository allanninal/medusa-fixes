/**
 * Find Stripe PaymentIntents that captured money with no matching Medusa order,
 * and repair them the safe way. Never inserts a synthetic order through the
 * Admin API. DRY_RUN=true only logs the reconciliation records it would act
 * on. The one safe repair is retrying POST /store/carts/{id}/complete, the
 * same route the storefront already calls, since completeCartWorkflow's
 * idempotent flag was set to false in Medusa v2.8.0 specifically so a stalled
 * completion can be retried.
 *
 * Guide: https://www.allanninal.dev/medusa/stripe-captured-no-order-created/
 */
import { pathToFileURL } from "node:url";

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
const STRIPE_API = "https://api.stripe.com/v1";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "pk_dummy";

const GRACE_MS = Number(process.env.GRACE_MINUTES || 10) * 60 * 1000;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function decideReconciliation({
  stripePaymentIntentId,
  stripeStatus,
  capturedAtMs,
  nowMs,
  graceMs,
  medusaPaymentDataIds,
  cartCompletedAt,
  cartHasOrderId,
}) {
  const matchedInMedusa = medusaPaymentDataIds.includes(stripePaymentIntentId);

  if (matchedInMedusa && (cartCompletedAt !== null || cartHasOrderId)) {
    return "already_reconciled";
  }
  if (stripeStatus !== "succeeded") {
    return "ok"; // nothing captured yet, not our problem
  }
  if (nowMs - capturedAtMs < graceMs) {
    return "too_recent"; // webhook may still be in flight, don't flag yet
  }
  if (!matchedInMedusa && cartCompletedAt === null && !cartHasOrderId) {
    return "orphaned_capture_needs_manual_complete";
  }
  return "ok";
}

async function recentSucceededPaymentIntents(lookbackHours = 24) {
  const out = [];
  let startingAfter = null;
  const since = Math.floor(Date.now() / 1000) - lookbackHours * 3600;
  while (true) {
    const params = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`${STRIPE_API}/payment_intents?${params}`, {
      headers: { Authorization: `Basic ${Buffer.from(STRIPE_KEY + ":").toString("base64")}` },
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    const body = await res.json();
    for (const pi of body.data) if (pi.status === "succeeded") out.push(pi);
    if (!body.has_more) return out;
    startingAfter = body.data[body.data.length - 1].id;
  }
}

async function getAdminToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  return (await res.json()).token;
}

async function allMedusaPaymentDataIds(token) {
  const ids = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `${BASE_URL}/admin/payments?fields=id,data&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    for (const payment of body.payments) {
      const pid = payment.data?.id;
      if (pid) ids.push(pid);
    }
    offset += limit;
    if (offset >= body.count) return ids;
  }
}

async function getCart(cartId) {
  const res = await fetch(`${BASE_URL}/store/carts/${cartId}`, {
    headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).cart;
}

async function completeCart(cartId) {
  const res = await fetch(`${BASE_URL}/store/carts/${cartId}/complete`, {
    method: "POST",
    headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  if (body.type === "order") return body.order;
  throw new Error(`cart ${cartId} did not complete into an order: ${JSON.stringify(body)}`);
}

export async function run() {
  const token = await getAdminToken();
  const medusaPaymentDataIds = await allMedusaPaymentDataIds(token);
  const paymentIntents = await recentSucceededPaymentIntents();
  const nowMs = Date.now();

  const flagged = [];
  for (const pi of paymentIntents) {
    const cartId = pi.metadata?.cart_id;
    if (!cartId) continue;
    const cart = await getCart(cartId);
    const outcome = decideReconciliation({
      stripePaymentIntentId: pi.id,
      stripeStatus: pi.status,
      capturedAtMs: pi.created * 1000,
      nowMs,
      graceMs: GRACE_MS,
      medusaPaymentDataIds,
      cartCompletedAt: cart.completed_at ?? null,
      cartHasOrderId: Boolean(cart.order),
    });
    if (outcome === "orphaned_capture_needs_manual_complete") {
      flagged.push([pi, cartId]);
    }
  }

  if (flagged.length === 0) {
    console.log(`No orphaned captures found across ${paymentIntents.length} succeeded PaymentIntent(s).`);
    return;
  }

  for (const [pi, cartId] of flagged) {
    console.warn(
      `Orphaned capture: PI ${pi.id} amount=${pi.amount} cart=${cartId} captured_at=${pi.created}. ${DRY_RUN ? "Would retry cart complete" : "Retrying cart complete"}`
    );
    if (DRY_RUN) continue;

    const freshCart = await getCart(cartId);
    if (freshCart.completed_at || freshCart.order) {
      console.log(`Cart ${cartId} completed between detection and repair. Skipping.`);
      continue;
    }

    try {
      const order = await completeCart(cartId);
      console.log(`Cart ${cartId} completed into order ${order.id}.`);
    } catch (err) {
      console.error(
        `Cart ${cartId} failed to complete for PI ${pi.id}: ${err.message}. Flagging to support for manual /admin/draft-orders reconciliation.`
      );
    }
  }

  console.log(`Done. ${flagged.length} orphaned capture(s) ${DRY_RUN ? "to review" : "processed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
