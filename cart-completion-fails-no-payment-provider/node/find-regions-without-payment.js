/**
 * Find Medusa regions that cannot complete a cart because of a payment provider gap, safely.
 *
 * Completing a cart creates or reuses a payment_collection and asks the region's
 * linked payment providers to open a payment session. A provider only shows up
 * for a region when it is registered in medusa-config, linked to the region in
 * the Admin, and able to authenticate with its own credentials. A merchant can
 * set up a region with the right currency and countries and never link a
 * payment provider, or link one that is not actually registered, or link one
 * whose credentials are invalid. In every case the cart builds fine and only
 * fails when checkout tries to complete.
 *
 * This script reports every region missing a working payment provider. It does
 * not link a payment provider automatically, since that is a business and
 * compliance decision tied to currency, licensing, and the merchant's account
 * with that provider. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/cart-completion-fails-no-payment-provider/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Only used if an operator explicitly opts into the guarded repair path.
const TARGET_PROVIDER_ID = (process.env.TARGET_PROVIDER_ID || "").trim() || null;

export function findRegionsWithoutWorkingPayment(regionsWithEnabled) {
  const results = [];
  for (const region of regionsWithEnabled) {
    const linked = region.linkedProviderIds || [];
    const enabled = new Set(region.enabledProviderIds || []);

    if (linked.length === 0) {
      results.push({ regionId: region.id, regionName: region.name, reason: "no_provider_linked" });
      continue;
    }

    if (!linked.some((pid) => enabled.has(pid))) {
      results.push({ regionId: region.id, regionName: region.name, reason: "linked_provider_not_enabled" });
    }
  }
  return results;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getRegions(sdk) {
  const { regions } = await sdk.admin.region.list({
    fields: "id,name,currency_code,*payment_providers",
  });
  return regions.map((region) => ({
    id: region.id,
    name: region.name,
    linkedProviderIds: (region.payment_providers || []).map((p) => p.id),
  }));
}

async function getEnabledProviderIds(sdk, regionId) {
  const { payment_providers } = await sdk.admin.paymentProvider.list({ region_id: regionId });
  return new Set(payment_providers.map((p) => p.id));
}

function printPlannedRepair(gap) {
  console.log(`  [DRY RUN] would POST /admin/regions/${gap.regionId} {payment_providers: ["${TARGET_PROVIDER_ID}"]}`);
}

async function applyRepair(sdk, gap) {
  return sdk.admin.region.update(gap.regionId, {
    payment_providers: [TARGET_PROVIDER_ID],
  });
}

export async function run() {
  const sdk = await getSdk();
  const regions = await getRegions(sdk);

  const regionsWithEnabled = [];
  for (const region of regions) {
    const enabledIds = await getEnabledProviderIds(sdk, region.id);
    regionsWithEnabled.push({ ...region, enabledProviderIds: [...enabledIds] });
  }

  const gaps = findRegionsWithoutWorkingPayment(regionsWithEnabled);

  if (gaps.length === 0) {
    console.log("No gaps found. Every region has at least one working payment provider.");
    return;
  }

  for (const gap of gaps) {
    console.log(`Gap: region=${gap.regionName} (${gap.regionId}) reason=${gap.reason}`);
    if (TARGET_PROVIDER_ID) {
      printPlannedRepair(gap);
      if (!DRY_RUN) {
        await applyRepair(sdk, gap);
        const enabledIds = await getEnabledProviderIds(sdk, gap.regionId);
        console.log(`  Applied. Re-verified provider is enabled: ${enabledIds.has(TARGET_PROVIDER_ID)}`);
      }
    }
  }

  console.log(`Done. ${gaps.length} region(s) missing a working payment provider.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
