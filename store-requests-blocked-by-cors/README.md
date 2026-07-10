# Store requests blocked by CORS

Medusa enforces CORS on every `/store/*` route via `storeCors` in
`medusa-config.ts`, backed by the `STORE_CORS` environment variable. It is a
strict pattern/string match against the browser's `Origin` header, not a
database-backed or Admin API-managed setting. CORS errors surface when the
storefront's real origin (a new production domain, a `www.` variant, a
preview or staging URL, or a `https://` versus `http://` mismatch) was never
added to `STORE_CORS`, or when the env var was updated but the backend
process was never restarted, so the old value is still loaded in memory. A
related but distinct failure is a missing or invalid
`x-publishable-api-key` header, which throws a 401 that is often
misdiagnosed as CORS because both look like a failed request in the browser.

Because there is no Admin API for CORS config, this script never writes
anything. It probes the live backend with a real `OPTIONS` preflight for
every candidate storefront origin, separately checks whether a valid
publishable key is being rejected, classifies each origin with a pure
decision function, and reports the exact origin string and file to change.
Only a human edits `medusa-config.ts` / `STORE_CORS` and redeploys.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/store-requests-blocked-by-cors/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STOREFRONT_ORIGINS="https://shop.example.com,https://www.shop.example.com,http://localhost:8000"
export DRY_RUN="true"   # this script only ever reports; DRY_RUN just controls log verbosity

python store-requests-blocked-by-cors/python/diagnose_store_cors.py
node   store-requests-blocked-by-cors/node/diagnose-store-cors.js
```

`diagnose_cors_gap` / `diagnoseCorsGap` is a pure function: given the origins
that already pass a live preflight check, the origin under test, and whether
a publishable key check passed, it returns a deterministic
`{verdict, reason}`. A missing or invalid publishable key always wins as
`NOT_CORS_PAK_ISSUE`, since that 401 looks identical to CORS in a browser but
has a different fix. Everything else is classified as `OK`, `CORS_MISMATCH`,
or `STALE_CONFIG`, and the script only ever logs a report, it never edits
`medusa-config.ts`, `STORE_CORS`, or redeploys anything.

## Test

```bash
pytest store-requests-blocked-by-cors/python
node --test store-requests-blocked-by-cors/node
```
