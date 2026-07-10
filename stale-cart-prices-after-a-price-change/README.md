# Stale cart prices after a price change

A cart line item's `unit_price` in Medusa v2 is calculated once by the Pricing module and stored as a snapshot when the item is added or last touched, not a live pointer to the price set. Updating a variant's price or a price list's rows only writes to the Pricing module's own tables. Nothing re-runs the cart's price calculation until the cart itself is touched again, so any cart left open across a price change keeps quoting the old amount all the way to checkout. This script lists open carts, compares each non custom priced line item's `unit_price` against the live price for that variant, currency, and region, flags the stale ones, and can repair them one cart at a time behind a dry run guard.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/stale-cart-prices-after-a-price-change/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python stale-cart-prices-after-a-price-change/python/reconcile_stale_cart_prices.py
node   stale-cart-prices-after-a-price-change/node/reconcile-stale-cart-prices.js
```

`find_stale_cart_line_items` is a pure function: given a list of open carts and a map of live prices keyed by `variant_id:currency_code:region_id`, it flags a line item only when it is not `is_custom_price`, a live price exists for its variant/currency/region, the amounts differ, and the line item was last touched before the live price's own `updated_at`. With `DRY_RUN=true` the script only logs the `cart_id`, `line_item_id`, and old versus new price. With `DRY_RUN=false` it calls the line item update route with no `unit_price` override so Medusa's own `updateLineItemInCartWorkflow` recomputes the price, then re-fetches the cart to confirm it, one cart at a time. It never bulk overwrites and never touches a custom priced line item.

## Test

```bash
pytest stale-cart-prices-after-a-price-change/python
node --test stale-cart-prices-after-a-price-change/node
```
