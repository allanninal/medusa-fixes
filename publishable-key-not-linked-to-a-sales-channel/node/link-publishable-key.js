/**
 * Find Medusa publishable keys with zero active sales-channel links and link them, safely.
 *
 * A publishable key only scopes /store/* requests through a link to one or more sales
 * channels. If that link is missing, or every linked channel is disabled, the key
 * resolves to zero sales channels and the storefront sees no products. This lists
 * every publishable key, decides what to do with a pure function, and only writes
 * when a target sales channel is explicit or there is exactly one unambiguous
 * default channel. Every other case is reported only. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/publishable-key-not-linked-to-a-sales-channel/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const SALES_CHANNEL_ID_OVERRIDE = (process.env.SALES_CHANNEL_ID || "").trim() || null;

export function decideApiKeyRepair(apiKey, defaultSalesChannelId) {
  if (apiKey.revoked_at) {
    return { action: "none", reason: "key revoked" };
  }

  const activeLinks = (apiKey.sales_channels || []).filter((sc) => !sc.is_disabled);
  if (activeLinks.length > 0) {
    return { action: "none", reason: "already linked to an active sales channel" };
  }

  if (defaultSalesChannelId === null || defaultSalesChannelId === undefined) {
    return { action: "flag", reason: "no sales channel linked and no unambiguous default to link" };
  }

  return {
    action: "link",
    reason: "key has zero active sales-channel links",
    salesChannelIdToAdd: defaultSalesChannelId,
  };
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getPublishableKeys(sdk) {
  const { api_keys } = await sdk.admin.apiKey.list({
    type: "publishable",
    fields: "id,token,title,revoked_at,*sales_channels",
  });
  return api_keys;
}

async function getEnabledSalesChannels(sdk) {
  const { sales_channels } = await sdk.admin.salesChannel.list({
    fields: "id,name,is_disabled",
  });
  return sales_channels.filter((c) => !c.is_disabled);
}

async function defaultSalesChannelId(sdk) {
  if (SALES_CHANNEL_ID_OVERRIDE) return SALES_CHANNEL_ID_OVERRIDE;
  const enabled = await getEnabledSalesChannels(sdk);
  return enabled.length === 1 ? enabled[0].id : null;
}

async function linkSalesChannel(sdk, apiKeyId, salesChannelId) {
  return sdk.admin.apiKey.batchSalesChannels(apiKeyId, { add: [salesChannelId] });
}

async function confirmLinked(sdk, apiKeyId, salesChannelId) {
  const { api_key } = await sdk.admin.apiKey.retrieve(apiKeyId, { fields: "id,*sales_channels" });
  const linkedIds = new Set(api_key.sales_channels.map((sc) => sc.id));
  return linkedIds.has(salesChannelId);
}

export async function run() {
  const sdk = await getSdk();
  const keys = await getPublishableKeys(sdk);
  const defaultScId = await defaultSalesChannelId(sdk);

  let linked = 0;
  let flagged = 0;
  for (const apiKey of keys) {
    const decision = decideApiKeyRepair(apiKey, defaultScId);
    console.log(`Key ${apiKey.id} (${apiKey.title}): action=${decision.action} reason=${decision.reason}`);

    if (decision.action === "flag") {
      flagged++;
      continue;
    }
    if (decision.action !== "link") continue;

    const scId = decision.salesChannelIdToAdd;
    console.log(`${DRY_RUN ? "Would link" : "Linking"} api key ${apiKey.id} to sales channel ${scId}`);
    if (!DRY_RUN) {
      await linkSalesChannel(sdk, apiKey.id, scId);
      const ok = await confirmLinked(sdk, apiKey.id, scId);
      if (!ok) throw new Error(`Link did not take effect for key ${apiKey.id}`);
      console.log(`Confirmed. Key ${apiKey.id} is now linked to sales channel ${scId}.`);
    }
    linked++;
  }

  console.log(`Done. ${linked} key(s) ${DRY_RUN ? "to link" : "linked"}, ${flagged} key(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
