/**
 * Find Medusa v2 orders where a confirmed order edit canceled the payment
 * collection and left no capturable collection behind, while the order
 * still owes money. This is not auto-fixable: there is no supported route
 * to un-cancel a payment_collection. DRY_RUN=true (default) only reports
 * the affected orders. Only when DRY_RUN=false and a human has reviewed
 * the amount should a new payment collection be created and captured
 * against.
 *
 * Guide: https://www.allanninal.dev/medusa/order-edit-cancels-payment-collection/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const PAYMENT_PROVIDER_ID = process.env.MEDUSA_PAYMENT_PROVIDER_ID || "pp_system_default";

const ORDER_FIELDS =
  "id,display_id,status,payment_status,*summary," +
  "*payment_collections,*order_change";
const EDIT_CHANGE_STATUSES = new Set(["requested", "confirmed"]);
const CAPTURABLE_STATUSES = new Set(["not_paid", "awaiting", "authorized", "partially_authorized"]);

export function hasConfirmedEdit(order) {
  const change = order.order_change || {};
  return change.change_type === "edit" && EDIT_CHANGE_STATUSES.has(change.status);
}

export function classifyOrderPaymentEditState(order) {
  // Pure: no I/O. order has payment_status, payment_collections, summary.
  //
  // Returns { blocked, reason, canceledCollectionId, amountDue }. blocked is
  // true only when payment_status is not_paid, no payment_collection has a
  // capturable status, at least one payment_collection is canceled, and the
  // outstanding amount is greater than 0.
  if (order.payment_status !== "not_paid") {
    return { blocked: false, reason: null, canceledCollectionId: null, amountDue: 0 };
  }

  const collections = order.payment_collections || [];
  const hasCapturable = collections.some((pc) => CAPTURABLE_STATUSES.has(pc.status));
  const canceled = collections.find((pc) => pc.status === "canceled") || null;

  let amountDue = order.summary?.raw_difference_due;
  if (amountDue == null) {
    amountDue = collections
      .filter((pc) => pc.status !== "captured")
      .reduce((sum, pc) => sum + (pc.amount || 0), 0);
  }

  if (!hasCapturable && canceled && amountDue > 0) {
    return {
      blocked: true,
      reason: "canceled_collection_blocks_capture",
      canceledCollectionId: canceled.id,
      amountDue,
    };
  }

  return { blocked: false, reason: null, canceledCollectionId: null, amountDue: 0 };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listEditedOrders(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.order.list({ fields: ORDER_FIELDS, limit, offset });
    out.push(...body.orders.filter(hasConfirmedEdit));
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function createPaymentCollection(sdk, orderId, amount) {
  // Documented, supported route for attaching a new collection to an order
  // missing a capturable one. Never call this against the canceled
  // collection's id, this always creates a brand new one.
  return sdk.client.fetch(`/admin/orders/${orderId}/payment-collections`, {
    method: "POST",
    body: { amount },
  });
}

async function createPaymentSession(sdk, collectionId, providerId) {
  return sdk.client.fetch(`/admin/payment-collections/${collectionId}/payment-sessions`, {
    method: "POST",
    body: { provider_id: providerId },
  });
}

async function capturePayment(sdk, paymentId) {
  return sdk.admin.payment.capture(paymentId, {});
}

export async function run() {
  const sdk = await login();
  const orders = await listEditedOrders(sdk);

  const flagged = [];
  for (const order of orders) {
    const result = classifyOrderPaymentEditState(order);
    if (result.blocked) flagged.push([order, result]);
  }

  if (flagged.length === 0) {
    console.log(`No blocked orders found across ${orders.length} edited order(s).`);
    return;
  }

  for (const [order, result] of flagged) {
    console.warn(
      `Order ${order.id} (display #${order.display_id}): canceled_collection=${result.canceledCollectionId} amount_due=${result.amountDue}. ${DRY_RUN ? "Would report only" : "Reported, awaiting operator action"}`
    );
    if (!DRY_RUN) {
      // This script intentionally never auto-creates a payment collection or
      // auto-captures. An operator must confirm the amount against
      // order.summary.raw_difference_due first, then call
      // createPaymentCollection(), createPaymentSession(), and
      // capturePayment() explicitly, one order at a time.
      console.warn(
        `Order ${order.id}: DRY_RUN is off, but this script never auto-creates a payment collection. Confirm amount_due=${result.amountDue} against order.summary.raw_difference_due, then call createPaymentCollection() and createPaymentSession() by hand.`
      );
    }
  }

  console.log(`Done. ${flagged.length} order(s) blocked by a canceled payment collection.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
