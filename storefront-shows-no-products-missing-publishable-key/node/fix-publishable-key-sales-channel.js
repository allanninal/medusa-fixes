/**
 * Find Medusa publishable API keys that match no products and repair the safe case.
 *
 * In Medusa v2, every /store/* request is scoped by the x-publishable-api-key header,
 * and that key's scope is defined entirely by which sales channels are linked to it.
 * A key with zero linked sales channels is valid but matches no products, so
 * /store/products silently returns an empty array instead of erroring. This lists
 * every publishable key, classifies it with a pure decision function, and for the
 * "no_sales_channels" case, links it to the default sales channel. Every other
 * classification (revoked, channels_disabled, channels_empty) is reported only,
 * never auto-fixed. Run once, or on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/storefront-shows-no-products-missing-publishable-key/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SALES_CHANNEL_ID_OVERRIDE = (process.env.SALES_CHANNEL_ID || "").trim() || null;

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, revoked_at: string|null, sales_channels: { id: string, is_disabled: boolean }[] }} key
 * @param {Record<string, number>} productCountBySalesChannel
 * @returns {{ status: "ok"|"revoked"|"no_sales_channels"|"channels_disabled"|"channels_empty", action: "none"|"flag"|"link_default_channel" }}
 */
export function decidePublishableKeyFix(key, productCountBySalesChannel) {
  if (key.revoked_at) {
    return { status: "revoked", action: "flag" };
  }

  const channels = key.sales_channels || [];
  if (channels.length === 0) {
    return { status: "no_sales_channels", action: "link_default_channel" };
  }

  if (channels.every((ch) => ch.is_disabled === true)) {
    return { status: "channels_disabled", action: "flag" };
  }

  if (channels.every((ch) => (productCountBySalesChannel[ch.id] || 0) === 0)) {
    return { status: "channels_empty", action: "flag" };
  }

  return { status: "ok", action: "none" };
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function adminGet(token, path, params = {}) {
  const url = new URL(`${BACKEND_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status} on GET ${path}`);
  return res.json();
}

async function adminPost(token, path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST ${path}`);
  return res.json();
}

async function listPublishableKeys(token) {
  const keys = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/api-keys", {
      type: "publishable",
      limit,
      offset,
      fields: "id,title,token,redacted,revoked_at,*sales_channels",
    });
    keys.push(...data.api_keys);
    offset += limit;
    if (offset >= data.count) return keys;
  }
}

async function productCountForSalesChannel(token, salesChannelId) {
  const data = await adminGet(token, "/admin/products", {
    "sales_channel_id[]": salesChannelId,
    limit: 1,
    fields: "id",
  });
  return data.count;
}

async function defaultSalesChannelId(token) {
  if (SALES_CHANNEL_ID_OVERRIDE) return SALES_CHANNEL_ID_OVERRIDE;
  const data = await adminGet(token, "/admin/sales-channels", {
    name: "Default Sales Channel",
    limit: 1,
  });
  if (!data.sales_channels.length) {
    throw new Error("No 'Default Sales Channel' found. Set SALES_CHANNEL_ID explicitly.");
  }
  return data.sales_channels[0].id;
}

async function linkDefaultSalesChannel(token, keyId, salesChannelId) {
  return adminPost(token, `/admin/api-keys/${keyId}/sales-channels`, {
    add: [{ id: salesChannelId }],
  });
}

export async function run() {
  const token = await getAdminToken();
  const keys = await listPublishableKeys(token);

  const productCountBySalesChannel = {};
  for (const key of keys) {
    for (const ch of key.sales_channels || []) {
      if (!(ch.id in productCountBySalesChannel)) {
        productCountBySalesChannel[ch.id] = await productCountForSalesChannel(token, ch.id);
      }
    }
  }

  let fixed = 0;
  for (const key of keys) {
    const decision = decidePublishableKeyFix(key, productCountBySalesChannel);
    console.log(`Key ${key.id} (${key.title}): status=${decision.status} action=${decision.action}`);

    if (decision.action !== "link_default_channel") continue;

    const scId = await defaultSalesChannelId(token);
    console.log(
      `Key ${key.id} has no sales channels. ${DRY_RUN ? "Would call" : "Calling"} POST /admin/api-keys/${key.id}/sales-channels {"add": [{"id": "${scId}"}]}`
    );
    if (!DRY_RUN) {
      await linkDefaultSalesChannel(token, key.id, scId);
      const after = await adminGet(token, `/admin/api-keys/${key.id}`, { fields: "id,*sales_channels" });
      console.log(`Confirmed. Key ${key.id} now has ${after.api_key.sales_channels.length} linked sales channel(s).`);
    }
    fixed++;
  }

  console.log(`Done. ${fixed} key(s) ${DRY_RUN ? "to link" : "linked"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
