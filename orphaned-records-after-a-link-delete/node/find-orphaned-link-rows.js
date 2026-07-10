/**
 * Find orphaned Medusa v2 module link rows left behind by a direct hard delete.
 *
 * Module link tables such as product_sales_channel have no database-level
 * foreign key, since modules must stay isolated and independently restorable.
 * Link.dismiss() and LinkModule delete only soft-delete the link row itself,
 * and a true cascade only fires for links explicitly configured that way. So
 * if a product or sales channel is hard-deleted directly through its own
 * module service, the link row survives, pointing at an id that no longer
 * resolves. This script lists candidate products with sales channels expanded,
 * cross-checks every id against its owning module's own retrieve route, and
 * reports every confirmed orphan. It only reports by default. Hard-deleting a
 * confirmed orphan link row must run from inside a Medusa server context that
 * can resolve the container and the specific link module, so that part is
 * documented in the guide, not executed by this script.
 *
 * Guide: https://www.allanninal.dev/medusa/orphaned-records-after-a-link-delete/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Pure decision table: no I/O, only booleans and primitives in.
// Returns one of: HEALTHY, ORPHAN_LEFT, ORPHAN_RIGHT, ORPHAN_BOTH, ALREADY_DELETED.
export function classifyLinkOrphan(linkRow, leftExists, rightExists) {
  if (linkRow.deleted_at != null) return "ALREADY_DELETED";
  if (!leftExists && !rightExists) return "ORPHAN_BOTH";
  if (!leftExists) return "ORPHAN_LEFT";
  if (!rightExists) return "ORPHAN_RIGHT";
  return "HEALTHY";
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listProductsWithSalesChannels(sdk) {
  const { products } = await sdk.admin.product.list({
    fields: "id,title,*sales_channels",
    limit: 1000,
  });
  return products;
}

async function entityExists(retrieveFn, id) {
  try {
    await retrieveFn(id);
    return true;
  } catch (err) {
    if (err?.status === 404 || err?.response?.status === 404) return false;
    throw err;
  }
}

async function productExists(sdk, productId) {
  return entityExists((id) => sdk.admin.product.retrieve(id), productId);
}

async function salesChannelExists(sdk, salesChannelId) {
  return entityExists((id) => sdk.admin.salesChannel.retrieve(id), salesChannelId);
}

/**
 * Reference only: only meaningful inside a Medusa server context where the
 * container can resolve the link module. Never call this against ids that
 * still resolve on both sides; sever a live link with link.dismiss() or
 * dismissRemoteLinkStep instead so both modules stay in sync.
 */
async function hardDeleteConfirmedOrphans(container, orphanedSalesChannelIds, dryRun) {
  const { ContainerRegistrationKeys, Modules } = await import("@medusajs/framework/utils");
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const linkModule = link.getLinkModule(
    Modules.PRODUCT, "sales_channel_id",
    Modules.SALES_CHANNEL, "sales_channel_id"
  );
  if (!dryRun) {
    return linkModule.delete({ sales_channel_id: orphanedSalesChannelIds });
  }
}

export async function run() {
  const sdk = await getSdk();
  let orphanCount = 0;
  for (const product of await listProductsWithSalesChannels(sdk)) {
    const leftExists = await productExists(sdk, product.id);
    for (const salesChannel of product.sales_channels || []) {
      const rightExists = salesChannel?.id != null && (await salesChannelExists(sdk, salesChannel.id));
      const linkRow = { deleted_at: null };
      const verdict = classifyLinkOrphan(linkRow, leftExists, rightExists);
      if (verdict === "ORPHAN_LEFT" || verdict === "ORPHAN_RIGHT" || verdict === "ORPHAN_BOTH") {
        orphanCount++;
        console.warn(
          `Orphan link (${verdict}): product ${product.id} <-> sales_channel ${salesChannel?.id}. ${DRY_RUN ? "would hard-delete" : "confirmed for hard delete"}`
        );
      }
    }
  }
  console.log(`Done. ${orphanCount} orphan link row(s) ${DRY_RUN ? "found" : "found (hard delete runs server-side)"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
