# Storefront shows no products

In Medusa v2, every `/store/*` request is scoped by the `x-publishable-api-key`
header, and that key's scope is defined entirely by which sales channels are
linked to it via the API Key module's link to the Sales Channel module. A key
with zero linked sales channels is valid, not rejected, but it matches no
products, so `/store/products` silently returns an empty array instead of
erroring. This happens most often when the storefront `.env` was generated
with a placeholder key, or a publishable key was created without the "Add
sales channels" step, or the products live only on a different sales channel
than the one the key is scoped to.

This script lists every publishable key, classifies each one with a pure
decision function, and for the one safe case, a key with no linked sales
channels, links it to the default sales channel. Every other classification
(revoked, all channels disabled, all channels empty of products) is reported
only, never auto-fixed, because those are merchant business decisions.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/storefront-shows-no-products-missing-publishable-key/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SALES_CHANNEL_ID=""   # optional, overrides the "Default Sales Channel" lookup
export DRY_RUN="true"

python storefront-shows-no-products-missing-publishable-key/python/fix_publishable_key_sales_channel.py
node   storefront-shows-no-products-missing-publishable-key/node/fix-publishable-key-sales-channel.js
```

`decide_publishable_key_fix` / `decidePublishableKeyFix` is a pure function: given
a key record and a map of product counts per sales channel, it returns a
deterministic `{status, action}`. Only `no_sales_channels` gets `action:
"link_default_channel"`; everything else gets `action: "flag"` so a human makes
the call. Start with `DRY_RUN=true` to see the planned `POST` body and the
before and after `sales_channels` diff before writing anything.

## Test

```bash
pytest storefront-shows-no-products-missing-publishable-key/python
node --test storefront-shows-no-products-missing-publishable-key/node
```
