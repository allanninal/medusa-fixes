/**
 * Find Medusa orders where a sales-channel scoped promotion applied outside its channel.
 * Cross-checks every promotion's sales_channel_id rule against the orders it actually
 * touched and reports confirmed leaks. Never mutates a promotion or an order.
 * Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/promotion-ignores-channel-condition/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_LIMIT = Number(process.env.ORDER_LIMIT || 100);

const PROMOTION_FIELDS = "id,code,status,*application_method,*rules";
const ORDER_FIELDS = "id,sales_channel_id,promotions.id,promotions.code,promotions.rules,total,currency_code";

function channelRules(promotion) {
  return (promotion.rules || []).filter((r) => r.attribute === "sales_channel_id");
}

/**
 * Pure: returns true when a promotion's sales_channel_id rules (if any) are
 * satisfied by cartSalesChannelId. No channel rules means no restriction.
 * Unknown operators and a missing channel id fail closed (return false),
 * mirroring how a channel condition is supposed to be enforced.
 */
export function isPromotionAllowedForChannel(rules, cartSalesChannelId) {
  const channelRules_ = rules.filter((r) => r.attribute === "sales_channel_id");
  if (channelRules_.length === 0) return true;

  return channelRules_.every((r) => {
    if (cartSalesChannelId == null) return false;
    const isMember = r.values.includes(cartSalesChannelId);
    if (r.operator === "eq" || r.operator === "in") return isMember;
    if (r.operator === "ne" || r.operator === "nin") return !isMember;
    return false;
  });
}

/**
 * Pure: returns a list of leak reports, one per (order, promotion) pair where
 * the promotion has a sales_channel_id rule and the order's channel violates it.
 */
export function findLeaks(promotions, orders, channelNames) {
  const promoById = new Map(promotions.map((p) => [p.id, p]));
  const leaks = [];
  for (const order of orders) {
    const orderChannel = order.sales_channel_id;
    for (const applied of order.promotions || []) {
      const promotion = promoById.get(applied.id) || applied;
      const rules = promotion.rules || applied.rules || [];
      const hasChannelRule = channelRules(promotion).length > 0 || channelRules(applied).length > 0;
      if (!hasChannelRule) continue;
      if (isPromotionAllowedForChannel(rules, orderChannel)) continue;
      const allowedIds = [
        ...new Set(
          [...channelRules(promotion), ...channelRules(applied)].flatMap((r) => r.values || [])
        ),
      ].sort();
      leaks.push({
        promotionId: promotion.id,
        code: promotion.code,
        expectedSalesChannelIds: allowedIds,
        orderId: order.id,
        actualSalesChannelId: orderChannel,
        actualSalesChannelName: channelNames[orderChannel] || orderChannel,
        orderTotal: order.total,
        currencyCode: order.currency_code,
      });
    }
  }
  return leaks;
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

async function listPromotions(token) {
  const url = new URL(`${BASE_URL}/admin/promotions`);
  url.searchParams.set("fields", PROMOTION_FIELDS);
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.promotions;
}

async function listSalesChannels(token) {
  const url = new URL(`${BASE_URL}/admin/sales-channels`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return Object.fromEntries(body.sales_channels.map((sc) => [sc.id, sc.name]));
}

async function* listOrders(token, limit = ORDER_LIMIT) {
  let offset = 0;
  while (true) {
    const url = new URL(`${BASE_URL}/admin/orders`);
    url.searchParams.set("fields", ORDER_FIELDS);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    if (!body.orders.length) return;
    for (const order of body.orders) yield order;
    offset += limit;
    if (offset >= body.count) return;
  }
}

export async function run() {
  const token = await getToken();
  const allPromotions = await listPromotions(token);
  const promotions = allPromotions.filter((p) => channelRules(p).length > 0);
  const channelNames = await listSalesChannels(token);

  const orders = [];
  for await (const order of listOrders(token)) orders.push(order);

  const leaks = findLeaks(promotions, orders, channelNames);
  if (leaks.length === 0) {
    console.log(`No sales-channel leaks found across ${orders.length} order(s).`);
    return;
  }

  for (const leak of leaks) {
    console.warn(
      `Promotion ${leak.promotionId} (${leak.code}) applied on order ${leak.orderId} in channel ${leak.actualSalesChannelName}, expected one of ${JSON.stringify(leak.expectedSalesChannelIds)}. Total ${leak.orderTotal} ${leak.currencyCode}. ${DRY_RUN ? "Would flag." : "Flagged."}`
    );
  }
  console.log(`Done. ${leaks.length} confirmed leak(s) found. Report only, nothing was changed.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
