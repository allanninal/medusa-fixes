# Multi-channel key zero stock

In Medusa v2, the Store API is supposed to resolve a variant's available
inventory by unioning the stock locations linked to every sales channel a
publishable key is scoped to, then summing `stocked_quantity` minus
`reserved_quantity` across those locations. A known bug
([medusajs/medusa#7907](https://github.com/medusajs/medusa/issues/7907), and
the related `sales_channel_id` stripping regression in
[#12209](https://github.com/medusajs/medusa/issues/12209)) only handles a key
scoped to exactly one sales channel. When a key is scoped to more than one,
the location filter can be silently narrowed to a single channel or dropped
entirely, so the join returns no rows and `inventory_quantity` is computed as
0 even though the admin API shows real stock at the linked locations.

This script never writes anything, in `DRY_RUN` or not, because the defect
lives in Medusa core's request-scoping logic (or a custom middleware
reproducing it), not in the store's data. It reads the admin's location
levels and the Store API's reported quantity for a sample of products under a
real publishable key, classifies each variant with a pure decision function,
and reports every mismatch whose fingerprint matches this bug: the key has
more than one linked sales channel, the admin side proves real stock exists
across the key's expected stock locations, and the Store API reports exactly
0.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/multi-channel-key-zero-stock/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export MEDUSA_PUBLISHABLE_KEY_ID="pk_..."   # the api key's admin id, used to read its scope
export DRY_RUN="true"                        # this diagnostic never writes, in either mode

python multi-channel-key-zero-stock/python/diagnose_multi_channel_zero_stock.py
node   multi-channel-key-zero-stock/node/diagnose-multi-channel-zero-stock.js
```

`diagnose_zero_stock_mismatch` / `diagnoseZeroStockMismatch` is a pure
function: given the key's scoped sales channel ids, a map of admin location
levels, a map of expected stock locations per sales channel, and what the
Store API reported, it unions the expected locations across every channel the
key is scoped to, sums `max(stocked_quantity - reserved_quantity, 0)` over
that union, and returns `{isBug, expectedAvailable, reason}`. It only reports
`isBug: true` when the key has more than one channel, the admin side computes
a positive expected quantity, and the store reported 0.

No write endpoint is ever called. The output is a log of mismatches to
investigate, upgrade Medusa, patch the middleware that builds
`sales_channel_id` so it always passes the full array, or split the
storefront into one publishable key per sales channel as a stopgap.

## Test

```bash
pytest multi-channel-key-zero-stock/python
node --test multi-channel-key-zero-stock/node
```
