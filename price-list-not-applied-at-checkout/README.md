# Price list not applied at checkout

A price list can sit in the Medusa admin with `status: "active"` and still never touch a real cart. Medusa only applies a price list when its status is active, the current time falls inside its `starts_at`/`ends_at` window, and it has a price row matching the cart's exact currency and any region or customer group rule. None of those checks raise an error when they fail, so the storefront just falls back to the default price with no warning. This script audits every price list against your regions and reports the exact mismatch and admin fix instead of guessing at commercial data.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/price-list-not-applied-at-checkout/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python price-list-not-applied-at-checkout/python/audit_price_lists.py
node   price-list-not-applied-at-checkout/node/audit-price-lists.js
```

`get_price_list_effective_state` and `has_matching_price` are pure functions (the current time is passed in): a list is flagged as `draft`, `scheduled`, `expired`, or `active-but-no-matching-currency/region-price` by comparing its own status and dates against now, and its prices against each region's currency and rules. The script never writes to the store. It only logs the `POST /admin/price-lists/{id}` payload a human should apply, because dates, status, and amounts are commercial decisions the tool cannot safely guess. `DRY_RUN` gates even that logging distinction.

## Test

```bash
pytest price-list-not-applied-at-checkout/python
node --test price-list-not-applied-at-checkout/node
```
