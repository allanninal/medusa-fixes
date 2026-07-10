/**
 * Diagnose Medusa Store API requests blocked by CORS.
 *
 * Medusa enforces CORS on /store/* routes via storeCors in medusa-config.ts,
 * backed by the STORE_CORS environment variable. There is no Admin API for
 * this setting, so this script never writes anything. It probes the live
 * backend with a real OPTIONS preflight for every configured storefront
 * origin, checks whether a valid publishable key is being rejected too (a
 * separate 401 issue often mistaken for CORS), and reports the exact origin
 * string and file to change. Only a human edits medusa-config.ts and
 * redeploys.
 *
 * Guide: https://www.allanninal.dev/medusa/store-requests-blocked-by-cors/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const STOREFRONT_ORIGINS = (process.env.STOREFRONT_ORIGINS || "http://localhost:8000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function normalize(origin) {
  const trimmed = origin.trim().replace(/\/+$/, "");
  if (!trimmed.includes("://")) return trimmed.toLowerCase();
  const [scheme, ...rest] = trimmed.split("://");
  return `${scheme.toLowerCase()}://${rest.join("://").toLowerCase()}`;
}

/**
 * Pure decision function. No I/O.
 *
 * @param {string[]} configuredOrigins origins that already passed a live preflight check
 *   (Medusa currently answers with a matching Access-Control-Allow-Origin for them)
 * @param {string} requestOrigin the origin under test
 * @param {boolean} hasValidPublishableKey result of a separate, unrelated check
 *   (GET /store/regions with x-publishable-api-key did not return 401)
 * @returns {{ verdict: "OK"|"CORS_MISMATCH"|"NOT_CORS_PAK_ISSUE"|"STALE_CONFIG", reason: string }}
 */
export function diagnoseCorsGap(configuredOrigins, requestOrigin, hasValidPublishableKey) {
  if (!hasValidPublishableKey) {
    return {
      verdict: "NOT_CORS_PAK_ISSUE",
      reason: "Request failed with 401, not a CORS rejection. Attach a valid x-publishable-api-key.",
    };
  }

  const normalizedRequest = normalize(requestOrigin);
  const normalizedConfigured = configuredOrigins.map(normalize);

  if (normalizedConfigured.includes(normalizedRequest)) {
    return {
      verdict: "OK",
      reason: "Origin is already listed in STORE_CORS. If it still fails in the browser, confirm the " +
        "running backend process has been restarted since the env var changed, otherwise treat it as STALE_CONFIG.",
    };
  }

  const hostOf = (o) => o.split("://").pop().split(":")[0];
  const sameHostEntries = normalizedConfigured.filter((o) => hostOf(o) === hostOf(normalizedRequest));

  if (sameHostEntries.length) {
    const closest = sameHostEntries[0];
    const reqScheme = normalizedRequest.split("://")[0];
    const cfgScheme = closest.split("://")[0];
    const reason = reqScheme !== cfgScheme
      ? `origin uses ${reqScheme} but STORE_CORS only lists ${cfgScheme}://same-host`
      : `origin port or path differs from the closest configured entry ${closest}`;
    return { verdict: "CORS_MISMATCH", reason };
  }

  return {
    verdict: "CORS_MISMATCH",
    reason: `origin ${normalizedRequest} has no matching host in STORE_CORS at all`,
  };
}

async function getAdminToken(sdk) {
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
}

async function firstPublishableKey(sdk) {
  const { api_keys: keys } = await sdk.admin.apiKey.list({
    type: "publishable",
    limit: 1,
    fields: "id,token,revoked_at",
  });
  return keys.length ? keys[0].token : null;
}

async function publishableKeyIsValid(backendUrl, publishableKey) {
  if (!publishableKey) return false;
  const res = await fetch(`${backendUrl}/store/regions`, {
    headers: { "x-publishable-api-key": publishableKey },
  });
  return res.status !== 401;
}

async function preflightAllowsOrigin(backendUrl, origin) {
  const res = await fetch(`${backendUrl}/store/regions`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
  });
  const allowed = res.headers.get("access-control-allow-origin");
  return allowed === origin || allowed === "*";
}

export async function run() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await getAdminToken(sdk);

  const pak = await firstPublishableKey(sdk);
  const pakValid = await publishableKeyIsValid(BACKEND_URL, pak);

  const passingOrigins = [];
  for (const origin of STOREFRONT_ORIGINS) {
    if (await preflightAllowsOrigin(BACKEND_URL, origin)) passingOrigins.push(origin);
  }

  let gaps = 0;
  for (const origin of STOREFRONT_ORIGINS) {
    const result = diagnoseCorsGap(passingOrigins, origin, pakValid);
    console.log(`Origin ${origin}: verdict=${result.verdict} reason=${result.reason}`);

    if (result.verdict === "CORS_MISMATCH") {
      console.warn(
        `${DRY_RUN ? "Would report:" : "Report:"} Add ${origin} to STORE_CORS (and AUTH_CORS, per Medusa's ` +
        `docs) in medusa-config.ts or the STORE_CORS env var, then restart/redeploy the backend.`
      );
      gaps++;
    } else if (result.verdict === "NOT_CORS_PAK_ISSUE") {
      console.warn(
        `${DRY_RUN ? "Would report:" : "Report:"} Not a CORS defect. Attach a valid x-publishable-api-key ` +
        `tied to the storefront's sales channel. Verify via GET /admin/api-keys/{id} and ` +
        `/admin/api-keys/{id}/sales-channels.`
      );
      gaps++;
    }
  }

  console.log(`Done. ${gaps} origin(s) with a gap out of ${STOREFRONT_ORIGINS.length} checked.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
