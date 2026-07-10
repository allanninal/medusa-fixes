# Publishable key not linked to a sales channel

A Medusa v2 publishable key has no visibility into products on its own. It only
scopes `/store/*` requests through a many-to-many link to one or more sales
channels. If that link was never created, or the sales channel it pointed at
was later deleted or disabled, the key resolves to zero sales channels and the
storefront sees no products, even though products, prices, and inventory are
otherwise fine. This script resolves every publishable key, checks its active
sales-channel links with a pure decision function, and only links a key to a
sales channel when the target is explicit or there is exactly one unambiguous
default channel in the store. Everything else is reported for a human to
review.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/publishable-key-not-linked-to-a-sales-channel/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SALES_CHANNEL_ID=""   # optional: force a specific sc_... target
export DRY_RUN="true"

python publishable-key-not-linked-to-a-sales-channel/python/link_publishable_key.py
node   publishable-key-not-linked-to-a-sales-channel/node/link-publishable-key.js
```

`decide_api_key_repair` / `decideApiKeyRepair` is a pure function: a revoked key
or a key with at least one active sales-channel link is left alone, a key with
zero active links is only linked when a default sales channel id is known, and
otherwise it is flagged. The only write is
`POST /admin/api-keys/{api_key_id}/sales-channels`, and the script re-fetches
the key afterward to confirm the link took effect before reporting success.
Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest publishable-key-not-linked-to-a-sales-channel/python
node --test publishable-key-not-linked-to-a-sales-channel/node
```
