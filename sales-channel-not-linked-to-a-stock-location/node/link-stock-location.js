/**
 * Find Medusa sales channels with zero linked stock locations and link one, safely.
 *
 * Inventory availability is scoped by a stored link between the Sales Channel
 * module and the Stock Location module. Reservations, location-scoped inventory
 * levels, and cart or checkout availability checks all resolve through that
 * link. If a sales channel has zero linked stock locations, every product
 * becomes effectively unpurchasable through it, even though the inventory
 * items have valid location levels elsewhere. This lists every sales channel,
 * decides what to do with a pure function, and only writes when a target
 * stock location is explicit or there is exactly one unambiguous default
 * location in the store. Every other case is reported only. Run once, or on
 * a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/sales-channel-not-linked-to-a-stock-location/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STOCK_LOCATION_ID_OVERRIDE = (process.env.STOCK_LOCATION_ID || "").trim() || null;

export function planStockLocationLinks(salesChannels, availableLocations, defaultLocationId) {
  return salesChannels.map((sc) => {
    const needsLink = (sc.stock_locations || []).length === 0;
    let suggestedLocationId = null;
    if (needsLink) {
      if (defaultLocationId) {
        suggestedLocationId = defaultLocationId;
      } else if (availableLocations.length === 1) {
        suggestedLocationId = availableLocations[0].id;
      }
    }
    return {
      sales_channel_id: sc.id,
      sales_channel_name: sc.name,
      needs_link: needsLink,
      suggested_location_id: suggestedLocationId,
    };
  });
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getSalesChannels(sdk) {
  const channels = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.salesChannel.list({
      fields: "id,name,*stock_locations",
      limit,
      offset,
    });
    channels.push(...body.sales_channels);
    offset += limit;
    if (offset >= body.count) return channels;
  }
}

async function getStockLocations(sdk) {
  const { stock_locations } = await sdk.admin.stockLocation.list({
    fields: "id,name,*sales_channels",
  });
  return stock_locations;
}

async function linkStockLocation(sdk, stockLocationId, salesChannelId) {
  return sdk.admin.stockLocation.updateSalesChannels(stockLocationId, {
    add: [salesChannelId],
    remove: [],
  });
}

async function confirmLinked(sdk, salesChannelId, stockLocationId) {
  const { sales_channel } = await sdk.admin.salesChannel.retrieve(salesChannelId, {
    fields: "id,*stock_locations",
  });
  const linkedIds = new Set(sales_channel.stock_locations.map((loc) => loc.id));
  return linkedIds.has(stockLocationId);
}

export async function run() {
  const sdk = await getSdk();
  const salesChannels = await getSalesChannels(sdk);
  const availableLocations = await getStockLocations(sdk);

  const plans = planStockLocationLinks(salesChannels, availableLocations, STOCK_LOCATION_ID_OVERRIDE);

  let linked = 0;
  let flagged = 0;
  for (const plan of plans) {
    if (!plan.needs_link) {
      console.log(`Sales channel ${plan.sales_channel_id} (${plan.sales_channel_name}): already linked to a stock location`);
      continue;
    }

    if (!plan.suggested_location_id) {
      console.log(`Sales channel ${plan.sales_channel_id} (${plan.sales_channel_name}): flagged, no stock location linked and no unambiguous default to link`);
      flagged++;
      continue;
    }

    const locId = plan.suggested_location_id;
    console.log(`${DRY_RUN ? "Would link" : "Linking"} sales channel ${plan.sales_channel_id} to stock location ${locId}`);
    if (!DRY_RUN) {
      await linkStockLocation(sdk, locId, plan.sales_channel_id);
      const ok = await confirmLinked(sdk, plan.sales_channel_id, locId);
      if (!ok) throw new Error(`Link did not take effect for sales channel ${plan.sales_channel_id}`);
      console.log(`Confirmed. Sales channel ${plan.sales_channel_id} is now linked to stock location ${locId}.`);
    }
    linked++;
  }

  console.log(`Done. ${linked} sales channel(s) ${DRY_RUN ? "to link" : "linked"}, ${flagged} sales channel(s) flagged for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
