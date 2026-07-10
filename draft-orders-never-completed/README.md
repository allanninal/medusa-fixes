# Draft orders never completed

In Medusa v2 a draft order is an order with `is_draft_order` true and status `draft`. Completing it converts it into a real order, but nothing in the framework closes out a draft that a team started and then abandoned, so half-built quotes, test drafts, and orders someone meant to finish later just pile up in the store. This job lists draft orders, classifies each one with a pure function, and writes a report of the stale ones (older than a threshold, still in draft) for manual review. It is flag and report only. It never deletes a draft order on its own.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/draft-orders-never-completed/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MAX_AGE_DAYS="30"
export DRY_RUN="true"

python draft-orders-never-completed/python/report_stale_draft_orders.py
node   draft-orders-never-completed/node/report-stale-draft-orders.js
```

`is_stale_draft` is a pure function (the current time is passed in as epoch seconds): a draft order is only ever flagged when it is still a draft (`is_draft_order` true or status `draft`) and it was created longer than `MAX_AGE_DAYS` ago. A draft that already converted into a real order is no longer a draft, so it is never flagged. The only output is a JSON report of `draft_order_id`, `display_id`, `email`, `region_id`, `sales_channel_id`, `currency_code`, `total`, and `age_in_days`. Nothing is deleted by this script. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest draft-orders-never-completed/python
node --test draft-orders-never-completed/node
```
