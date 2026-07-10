/**
 * Detect a Medusa module link whose pivot table was never synced, safely.
 *
 * A module link created with defineLink() under src/links/ is backed by its own
 * pivot table, separate from each module's own migrations. That table is only
 * created or updated when db:sync-links runs, or as part of db:migrate. A
 * deploy that runs migrations but skips the link sync, or a link file added
 * after the last migrate, leaves the link defined in code but the table absent
 * or stale, so the expanded relation resolves empty for every record even
 * though the linked module independently has rows.
 *
 * This script only reads. It lists parent records with the relation expanded,
 * independently confirms the linked module has data of its own, classifies the
 * result with a pure function, and reports the verdict. It never touches a
 * pivot table directly, because there is no admin route that can create one.
 * When it reports LIKELY_UNMIGRATED_LINK, the fix is to run
 * `npx medusa db:sync-links` or `npx medusa db:migrate` against the deployed
 * backend, then run this check again.
 *
 * Guide: https://www.allanninal.dev/medusa/linked-data-missing-after-link-migration/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const LINK_DEFINITION_EXISTS_IN_CODE = (process.env.LINK_DEFINITION_EXISTS_IN_CODE || "true").toLowerCase() === "true";

export function hasLinkedField(product) {
  const brand = product.brand;
  if (brand === null || brand === undefined) return false;
  if (Array.isArray(brand)) return brand.length > 0;
  return true;
}

export function countLinkedFieldPresent(products) {
  return products.filter(hasLinkedField).length;
}

export function detectUnmigratedLink({
  totalParentRecords,
  parentsWithLinkedFieldPresent,
  linkedModuleHasAnyRecords,
  linkDefinitionExistsInCode,
}) {
  if (!linkDefinitionExistsInCode) return "NO_LINK_DEFINED";
  if (totalParentRecords === 0) return "OK";
  if (parentsWithLinkedFieldPresent === 0 && linkedModuleHasAnyRecords) return "LIKELY_UNMIGRATED_LINK";
  if (parentsWithLinkedFieldPresent === 0 && !linkedModuleHasAnyRecords) return "LINK_NOT_YET_POPULATED";
  return "OK";
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getProductsWithBrand(sdk) {
  const products = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.product.list({
      fields: "id,title,*brand",
      limit,
      offset,
    });
    products.push(...body.products);
    offset += limit;
    if (offset >= body.count) return products;
  }
}

async function getBrands(sdk) {
  const res = await sdk.client.fetch("/admin/brands", { query: { limit: 100 } });
  return res.brands;
}

export async function run() {
  const sdk = await getSdk();
  const products = await getProductsWithBrand(sdk);
  const brands = await getBrands(sdk);

  const total = products.length;
  const present = countLinkedFieldPresent(products);
  const linkedModuleHasAnyRecords = brands.length > 0;

  const verdict = detectUnmigratedLink({
    totalParentRecords: total,
    parentsWithLinkedFieldPresent: present,
    linkedModuleHasAnyRecords,
    linkDefinitionExistsInCode: LINK_DEFINITION_EXISTS_IN_CODE,
  });

  console.log(`Checked ${total} product(s), ${present} with brand present, ${brands.length} brand record(s) exist.`);
  console.log(`Verdict: ${verdict}`);

  if (verdict === "LIKELY_UNMIGRATED_LINK") {
    console.warn(
      "The brand relation is empty on every product even though brands exist. " +
      "This looks like the pivot table behind the link was never synced. " +
      "Run `npx medusa db:sync-links` or `npx medusa db:migrate` against the backend, " +
      "then run this check again to confirm."
    );
  } else if (verdict === "LINK_NOT_YET_POPULATED") {
    console.log("No brand records exist yet, so an empty relation is expected, not a migration bug.");
  } else if (verdict === "NO_LINK_DEFINED") {
    console.log("LINK_DEFINITION_EXISTS_IN_CODE is false, so this check does not apply here.");
  } else {
    console.log("Looks fine. At least one product resolved the brand relation.");
  }

  return verdict;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
