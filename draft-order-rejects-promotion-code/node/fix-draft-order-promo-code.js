/**
 * Classify and safely repair Medusa draft orders that reject a valid
 * promotion code because no order_change edit session is open yet. Never
 * activates a promotion whose status is not active, that is flagged for a
 * human. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/draft-order-rejects-promotion-code/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DRAFT_ORDER_FIELDS = "id,status,is_draft_order,*order_change";

// Reasons that are safe to repair automatically: only a missing or inactive
// edit session. A promotion that is genuinely not active is never forced.
const REPAIRABLE_REASONS = new Set(["no_active_edit_session", "edit_session_inactive"]);

/**
 * Pure: no I/O. Mirrors throwIfNotDraftOrder, throwIfOrderChangeIsNotActive,
 * throwIfCodesAreMissing, and throwIfCodesAreInactive, in that exact order.
 *
 * @param {{status: string, is_draft_order: boolean, order_change: {status: string, canceled_at: string|null, confirmed_at: string|null, declined_at: string|null} | null}} order
 * @param {{code: string, status: string}[]} promotions
 * @param {string[]} requestedCodes
 * @returns {{code: string, reason: "not_draft_order"|"no_active_edit_session"|"edit_session_inactive"|"code_not_found"|"code_not_active"|"ok"}[]}
 */
export function classifyPromoRejection(order, promotions, requestedCodes) {
  const byCode = new Map(promotions.map((p) => [p.code, p]));
  return requestedCodes.map((code) => {
    if (order.status !== "draft" && !order.is_draft_order) {
      return { code, reason: "not_draft_order" };
    }

    const orderChange = order.order_change;
    if (orderChange === null || orderChange === undefined) {
      return { code, reason: "no_active_edit_session" };
    }
    if (orderChange.canceled_at || orderChange.confirmed_at || orderChange.declined_at) {
      return { code, reason: "edit_session_inactive" };
    }

    const promo = byCode.get(code);
    if (!promo) return { code, reason: "code_not_found" };
    if (promo.status !== "active") return { code, reason: "code_not_active" };

    return { code, reason: "ok" };
  });
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

async function getDraftOrder(token, draftOrderId) {
  const url = new URL(`${BASE_URL}/admin/draft-orders/${draftOrderId}`);
  url.searchParams.set("fields", DRAFT_ORDER_FIELDS);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.draft_order;
}

async function findPromotionsByCodes(token, codes) {
  const url = new URL(`${BASE_URL}/admin/promotions`);
  for (const code of codes) url.searchParams.append("code[]", code);
  url.searchParams.set("fields", "id,code,status,campaign_id");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.promotions;
}

async function openEditSession(token, draftOrderId) {
  const res = await fetch(`${BASE_URL}/admin/draft-orders/${draftOrderId}/edit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function addPromoCodes(token, draftOrderId, codes) {
  const res = await fetch(`${BASE_URL}/admin/draft-orders/${draftOrderId}/edit/promotions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ promo_codes: codes }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function requestEdit(token, draftOrderId) {
  const res = await fetch(`${BASE_URL}/admin/draft-orders/${draftOrderId}/edit/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function confirmEdit(token, draftOrderId) {
  const res = await fetch(`${BASE_URL}/admin/draft-orders/${draftOrderId}/edit/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

export async function run(draftOrderIdArg, codesArg) {
  const draftOrderId = draftOrderIdArg || process.env.DRAFT_ORDER_ID;
  const codes = codesArg || (process.env.PROMO_CODES || "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!codes.length) {
    throw new Error("No promo codes provided. Set PROMO_CODES as a comma separated list.");
  }

  const token = await getToken();
  const order = await getDraftOrder(token, draftOrderId);
  const promotions = await findPromotionsByCodes(token, codes);

  const classified = classifyPromoRejection(order, promotions, codes);
  const repairableCodes = [];
  for (const { code, reason } of classified) {
    if (reason === "ok") {
      console.log(`Code ${code} already ok, nothing to do.`);
    } else if (REPAIRABLE_REASONS.has(reason)) {
      console.warn(
        `Code ${code} rejected: ${reason}. ${DRY_RUN ? "would open edit session and add it" : "opening edit session and adding it"}`
      );
      repairableCodes.push(code);
    } else if (reason === "code_not_active") {
      console.warn(`Code ${code} rejected: promotion is not active. Flagging for a human to activate it in Medusa Admin.`);
    } else {
      console.warn(`Code ${code} rejected: ${reason}. Not auto-repairable.`);
    }
  }

  if (!repairableCodes.length) {
    console.log(`Done. Nothing to repair for draft order ${draftOrderId}.`);
    return;
  }

  if (DRY_RUN) {
    console.log(`Dry run. Would repair ${repairableCodes.length} code(s) on draft order ${draftOrderId}.`);
    return;
  }

  await openEditSession(token, draftOrderId);
  await addPromoCodes(token, draftOrderId, repairableCodes);
  await requestEdit(token, draftOrderId);
  await confirmEdit(token, draftOrderId);
  console.log(`Done. Repaired ${repairableCodes.length} code(s) on draft order ${draftOrderId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
