/**
 * Find Medusa products that share a duplicate handle after an import, safely.
 *
 * Medusa v2 auto-generates a product handle from its title whenever a create
 * payload omits one, but that default is applied per row inside the create or
 * batch product workflow. It never checks the rest of the store for a
 * collision, and the handle column has no enforced unique database constraint.
 * A CSV import with duplicate or blank titles, or one that gets re-run after a
 * partial failure, can therefore leave several products sharing one handle.
 *
 * This lists every product, groups them by handle with a pure function, and
 * reports every group that has more than one member, including status and
 * variant SKUs, so a human can tell the real product from the import artifact.
 * The only write this script can make is renaming the newer duplicate's handle
 * to a disambiguated slug, and it only does that when DRY_RUN is explicitly set
 * to false. It never deletes a product. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/duplicate-product-handles-from-import/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const AUTO_REPAIR = (process.env.AUTO_REPAIR || "false").toLowerCase() === "true";

// Pure function. No I/O. Groups products by handle, keeps only groups with
// more than one member, and sorts each group's members by created_at
// ascending, oldest first (likely original).
export function findDuplicateHandles(products) {
  const byHandle = new Map();
  for (const p of products) {
    const key = p.handle;
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(p);
  }

  const groups = [];
  for (const [handle, members] of byHandle) {
    if (members.length > 1) {
      const ordered = [...members].sort(
        (a, b) => (a.created_at || "").localeCompare(b.created_at || "")
      );
      groups.push({ handle, products: ordered });
    }
  }
  return groups;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function listAllProducts(sdk) {
  const products = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const body = await sdk.admin.product.list({
      fields: "id,handle,title,status,created_at",
      limit,
      offset,
    });
    products.push(...body.products);
    offset += limit;
    if (offset >= body.count) return products;
  }
}

async function getProductDetail(sdk, productId) {
  const { product } = await sdk.admin.product.retrieve(productId, {
    fields: "id,handle,title,status,*variants.sku,*sales_channels.id",
  });
  return product;
}

async function renameHandle(sdk, productId, newHandle) {
  const { product } = await sdk.admin.product.update(productId, { handle: newHandle });
  return product;
}

export async function run() {
  const sdk = await getSdk();
  const products = await listAllProducts(sdk);
  const groups = findDuplicateHandles(products);

  if (groups.length === 0) {
    console.log(`Done. No duplicate product handles found across ${products.length} product(s).`);
    return;
  }

  console.log(`Found ${groups.length} duplicate handle group(s).`);
  for (const group of groups) {
    console.log(`Handle "${group.handle}" has ${group.products.length} products:`);
    for (const p of group.products) {
      const detail = await getProductDetail(sdk, p.id);
      const skus = (detail.variants || []).map((v) => v.sku);
      const channels = (detail.sales_channels || []).map((sc) => sc.id);
      console.log(
        `  id=${p.id} title="${p.title}" status=${detail.status} created_at=${p.created_at} skus=${JSON.stringify(skus)} sales_channels=${JSON.stringify(channels)}`
      );
    }

    if (!AUTO_REPAIR) continue;

    const [, ...newerDuplicates] = group.products;
    for (let i = 0; i < newerDuplicates.length; i++) {
      const dup = newerDuplicates[i];
      const newHandle = `${group.handle}-${i + 2}`;
      console.log(`${DRY_RUN ? "Would rename" : "Renaming"} product ${dup.id} handle to "${newHandle}"`);
      if (!DRY_RUN) await renameHandle(sdk, dup.id, newHandle);
    }
  }

  console.log(`Done. ${groups.length} duplicate handle group(s) reported.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
