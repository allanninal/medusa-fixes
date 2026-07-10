/**
 * Audit a Medusa promotion for why it is not applying to a cart.
 * Diffs the promotion's rules, target_rules, and buy_rules against a real cart's
 * context and reports the first mismatched rule, never mutates the promotion.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/promotion-not-applying-rules-mismatch/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PROMOTION_FIELDS =
  "id,code,is_automatic,status,*rules,*application_method," +
  "*application_method.target_rules,*application_method.buy_rules,*campaign";
const CART_FIELDS = "id,currency_code,region_id,customer_id,*items,*items.product_id";

function resolvePath(attribute, cartContext) {
  let node = cartContext;
  for (const part of attribute.split(".")) {
    if (Array.isArray(node)) {
      node = node.map((item) => (item && typeof item === "object" ? item[part] : null));
    } else if (node && typeof node === "object") {
      node = node[part];
    } else {
      return null;
    }
  }
  return node;
}

function asList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => asList(v));
  return [value];
}

/**
 * Pure: resolves rule.attribute as a dot-path into cartContext and applies
 * rule.operator against rule.values. Returns false (never throws) on any
 * unresolved path, empty values, or incompatible types, mirroring Medusa's
 * real fail-closed rule evaluation.
 */
export function ruleMatchesCart(rule, cartContext) {
  const { attribute, operator, values } = rule;
  if (!attribute || !operator || !values || values.length === 0) return false;

  const resolved = asList(resolvePath(attribute, cartContext));
  if (resolved.length === 0) return false;

  if (operator === "eq" || operator === "in") {
    return resolved.some((v) => values.includes(v));
  }
  if (operator === "ne") {
    return !resolved.some((v) => values.includes(v));
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    if (resolved.length !== 1) return false;
    const left = Number(resolved[0]);
    const right = Number(values[0]);
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "gte") return left >= right;
    if (operator === "lt") return left < right;
    return left <= right;
  }
  return false;
}

function buildFixPayload(rule) {
  if (rule.operator === "eq" && asList(rule.values).length > 0) {
    return { id: rule.id, operator: "in", values: rule.values };
  }
  return { id: rule.id, attribute: rule.attribute, values: rule.values };
}

export function buildCartContext(cart, customerGroupIds) {
  return {
    currency_code: cart.currency_code,
    region: { id: cart.region_id },
    region_id: cart.region_id,
    customer: { groups: customerGroupIds.map((id) => ({ id })) },
    items: { product: { id: (cart.items || []).map((item) => item.product_id) } },
  };
}

export function auditPromotion(promotion, cartContext) {
  // Pure: returns a list of report objects, one per rule that fails to match.
  const reports = [];

  if (promotion.status !== "active") {
    reports.push({
      promotionId: promotion.id,
      reason: `status is "${promotion.status}", not active`,
      ruleId: null,
      fix: { status: "active" },
    });
  }

  for (const rule of promotion.rules || []) {
    if (!ruleMatchesCart(rule, cartContext)) {
      reports.push({
        promotionId: promotion.id,
        reason: `eligibility rule ${rule.attribute} ${rule.operator} does not match the cart`,
        ruleId: rule.id,
        fix: buildFixPayload(rule),
      });
    }
  }

  const method = promotion.application_method || {};
  for (const rule of method.target_rules || []) {
    if (!ruleMatchesCart(rule, cartContext)) {
      reports.push({
        promotionId: promotion.id,
        reason: `target rule ${rule.attribute} ${rule.operator} does not match any cart item`,
        ruleId: rule.id,
        fix: buildFixPayload(rule),
      });
    }
  }
  for (const rule of method.buy_rules || []) {
    if (!ruleMatchesCart(rule, cartContext)) {
      reports.push({
        promotionId: promotion.id,
        reason: `buy rule ${rule.attribute} ${rule.operator} does not match any cart item`,
        ruleId: rule.id,
        fix: buildFixPayload(rule),
      });
    }
  }

  return reports;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function getPromotion(sdk, promotionId) {
  const body = await sdk.admin.promotion.retrieve(promotionId, { fields: PROMOTION_FIELDS });
  return body.promotion;
}

async function getCart(sdk, cartId) {
  const body = await sdk.admin.cart.retrieve(cartId, { fields: CART_FIELDS });
  return body.cart;
}

async function getCustomerGroups(sdk, customerId) {
  if (!customerId) return [];
  const body = await sdk.admin.customer.retrieve(customerId, { fields: "id,*groups" });
  return (body.customer.groups || []).map((g) => g.id);
}

export async function run(promotionId, cartId) {
  const sdk = await login();
  const promotion = await getPromotion(sdk, promotionId);
  const cart = await getCart(sdk, cartId);
  const customerGroupIds = await getCustomerGroups(sdk, cart.customer_id);
  const cartContext = buildCartContext(cart, customerGroupIds);

  const reports = auditPromotion(promotion, cartContext);
  if (reports.length === 0) {
    console.log(`Promotion ${promotionId} matches this cart on every rule.`);
    return;
  }

  for (const r of reports) {
    console.log(
      `Promotion ${r.promotionId}: ${r.reason}. ${DRY_RUN ? "Would send" : "Suggested"} payload: ${JSON.stringify(r.fix)}`
    );
  }
  console.log(`Done. ${reports.length} rule(s) flagged for promotion ${promotionId}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const promotionId = process.env.PROMOTION_ID;
  const cartId = process.env.CART_ID;
  run(promotionId, cartId).catch((err) => { console.error(err); process.exit(1); });
}
