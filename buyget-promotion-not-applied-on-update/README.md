# Buy X get Y promotions fail to apply during cart updates

A Medusa v2 `buyget` promotion can be created successfully with an `application_method` shape that looks reasonable, such as `target_type: "order"`, but is not supported by the buyget rule engine. The promotion shows active in the admin and stays attached to the cart, but every time `updateCartPromotionsWorkflow` re-fetches the cart and calls `computeActions()`, the engine finds no valid target to discount and silently returns zero adjustments. No error, no warning, just a promotion that never actually discounts anything.

This script lists your `buyget` promotions, flags any whose `application_method` is structurally invalid with a pure, testable rule, and, only when you explicitly set `DRY_RUN=false`, patches the corrected payload and helps you re-trigger Medusa's own recomputation to confirm the fix.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/buyget-promotion-not-applied-on-update/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python buyget-promotion-not-applied-on-update/python/fix_buyget_application_method.py
node   buyget-promotion-not-applied-on-update/node/fix-buyget-application-method.js
```

`is_buyget_application_method_valid` / `isBuygetApplicationMethodValid` is a pure function: it takes an `application_method` object and returns `{ valid, reasons }`, flagging empty `target_rules`, empty `buy_rules`, a missing or non-positive `buy_rules_min_quantity`, `target_type === "order"`, an `allocation` outside `["across", "each"]`, a missing `apply_to_quantity`, or a missing `max_quantity` when `allocation === "each"`. Nothing is written to a live promotion unless `DRY_RUN` is explicitly `"false"`. Start with `DRY_RUN=true` to review the diff and the count of affected open carts first.

## Test

```bash
pytest buyget-promotion-not-applied-on-update/python
node --test buyget-promotion-not-applied-on-update/node
```
