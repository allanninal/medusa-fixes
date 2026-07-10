# Abandoned carts pile up

A Medusa v2 cart is a first-class, persistent record in the Cart Module, created as soon as a shopper's session needs one and only marked complete by setting `completed_at` when it converts into an order. Medusa ships no default scheduled job for cart retention, so nothing expires, archives, or deletes a cart that never reaches checkout. This job lists carts, classifies each one with a pure function, cross-checks anything flagged against real orders, and writes a report of stale `cart_id` values for manual review. It is flag and report only. It never deletes a cart on its own.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/abandoned-carts-pile-up/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export STALE_DAYS="30"
export DRY_RUN="true"

python abandoned-carts-pile-up/python/report_stale_carts.py
node   abandoned-carts-pile-up/node/report-stale-carts.js
```

`classify_stale_cart` is a pure function (the current time is passed in): a cart is only ever flagged stale when `completed_at` is null, it has at least one line item, and it has gone longer than `STALE_DAYS` without an update. A completed cart is never stale, and an empty cart is treated as a bot or crawler session rather than real abandonment. Every flagged cart is cross-checked against `/admin/orders` so a cart that actually converted is never reported. The only output is a JSON report of `cart_id`, `email`, `region_id`, `sales_channel_id`, `item_count`, `cart_total`, and `age_in_days`. Nothing is deleted by this script. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest abandoned-carts-pile-up/python
node --test abandoned-carts-pile-up/node
```
