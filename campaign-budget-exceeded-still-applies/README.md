# Campaign budget exceeded but still applies

A Medusa campaign budget (`budget.limit` and `budget.used`) is only checked when a promotion is computed onto a cart. `used` only increments later, when an order actually completes, so a promotion already attached to a cart stays valid even after the budget crosses its limit. This script lists every campaign with a budget, flags the ones already over, gathers the promotions and recent orders riding on that budget, and only outside dry run deactivates the promotion or closes the campaign window so no new cart can pick it up. It never reverses a discount on an order that already completed, that is a decision for finance or support.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/campaign-budget-exceeded-still-applies/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export ORDERS_SINCE="2026-07-01T00:00:00Z"   # only used to narrow the order cross-check
export DRY_RUN="true"

python campaign-budget-exceeded-still-applies/python/flag_over_budget_campaigns.py
node   campaign-budget-exceeded-still-applies/node/flag-over-budget-campaigns.js
```

`is_campaign_over_budget` / `isCampaignOverBudget` is a pure function: a `null` `limit` means an unlimited budget and is never over, `used >= limit` is over budget, and `overageAmount` is `used - limit` clamped to zero or above. The only writes are `PATCH /admin/promotions/{promo_id}` with `{"status": "inactive"}` for every promotion still active on an over-budget campaign, gated entirely behind `DRY_RUN`. Nothing is ever written to a completed order. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest campaign-budget-exceeded-still-applies/python
node --test campaign-budget-exceeded-still-applies/node
```
