# Sales channel not linked to a stock location

A Medusa v2 sales channel has no inventory scope of its own. Reservations,
location-scoped inventory levels, and cart or checkout availability checks
all resolve "which locations serve this channel" through a stored many-to-many
link between the Sales Channel module and the Stock Location module. If that
link was never created, or the stock location it pointed at was later removed,
the channel resolves to zero stock locations and every product becomes
effectively unpurchasable through it, even though the inventory items have
valid location levels elsewhere. This script lists every sales channel, checks
its linked stock locations with a pure decision function, and only links a
channel to a stock location when the target is explicit or there is exactly
one unambiguous default location in the store. Everything else is reported
for a human to review.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/sales-channel-not-linked-to-a-stock-location/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STOCK_LOCATION_ID=""   # optional: force a specific sloc_... target
export DRY_RUN="true"

python sales-channel-not-linked-to-a-stock-location/python/link_stock_location.py
node   sales-channel-not-linked-to-a-stock-location/node/link-stock-location.js
```

`plan_stock_location_links` / `planStockLocationLinks` is a pure function: for
each sales channel it sets `needs_link` to true only when the channel has zero
linked stock locations, and it only suggests a stock location to link when a
default id is given or exactly one stock location exists in the whole store,
otherwise it leaves the suggestion null and forces a human decision. The only
write is `POST /admin/stock-locations/{stock_location_id}/sales-channels`, and
the script re-fetches the sales channel afterward to confirm the link took
effect before reporting success. Start with `DRY_RUN=true` to review the list
first.

## Test

```bash
pytest sales-channel-not-linked-to-a-stock-location/python
node --test sales-channel-not-linked-to-a-stock-location/node
```
