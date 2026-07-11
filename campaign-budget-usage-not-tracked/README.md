# Campaign budget usage never increments for Buy X Get Y

A Medusa campaign's `budget.used` is supposed to be incremented by the promotion workflows every time an order redeems a promotion tied to that campaign. For Buy X Get Y (`buyget`) promotions, the usage-accounting step in the `computeActions` and adjustment pipeline does not reliably emit or persist that update, so a campaign tied only to a buyget promotion can be redeemed indefinitely, or well past its `limit`, while `budget.used` stays at 0 or stale.

This script lists campaigns whose budget is tied to a buyget promotion, pulls the real redemptions from orders, recomputes what usage should actually be, and reports any campaign where the recomputed number disagrees with what is stored or has already crossed the limit. It only reports by default. It syncs `budget.used` only when `DRY_RUN=false`, and it never deactivates a live promotion on its own, it only prints the suggested review action.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/campaign-budget-usage-not-tracked/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python campaign-budget-usage-not-tracked/python/reconcile_campaign_budget.py
node   campaign-budget-usage-not-tracked/node/reconcile-campaign-budget.js
```

`reconcile_campaign_budget_usage` is the pure function at the core of this: given a campaign's stored budget and a flat list of redemptions, it recomputes usage (a count for `usage` budgets, a sum of discount totals for `spend` budgets) and returns whether the stored counter needs a sync and whether the campaign is already over budget. It does no I/O, so it is fully unit tested with fabricated data. Start with `DRY_RUN=true` to review the report before syncing anything.

## Test

```bash
pytest campaign-budget-usage-not-tracked/python
node --test campaign-budget-usage-not-tracked/node
```
