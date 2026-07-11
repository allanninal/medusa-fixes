# Promotion ignores its sales channel condition

A Medusa promotion scoped to one sales channel with a `sales_channel_id` rule can still apply on carts and orders from a different channel. Applying or computing promotions on a cart runs through a cart refresh workflow that builds its rule evaluation context from a fixed list of cart fields (`cartFieldsForRefreshSteps`). When that list omits `sales_channel_id`, the channel rule has nothing to compare against and is skipped instead of enforced. This is tracked as [medusajs/medusa#10089](https://github.com/medusajs/medusa/issues/10089) and fixed in [PR #10090](https://github.com/medusajs/medusa/pull/10090).

This tool never mutates a promotion or an order. It lists every promotion with a `sales_channel_id` rule, lists recent orders along with the promotions actually applied to them, and reports every confirmed leak: an order whose real sales channel violates a promotion's channel rule.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/promotion-ignores-channel-condition/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python promotion-ignores-channel-condition/python/find_channel_leaks.py
node   promotion-ignores-channel-condition/node/find-channel-leaks.js
```

`is_promotion_allowed_for_channel` is a pure function: given a promotion's rules and a cart or order's real `sales_channel_id`, it returns whether the channel condition is satisfied. No channel rules means no restriction. `eq`/`in` require membership in the rule's values, `ne`/`nin` require exclusion, and an unknown operator or a missing channel id fails closed. `find_leaks` uses it to cross-check real orders against the promotions applied to them and returns a report for every confirmed leak, never a mutation.

The only real fix is upgrading to a Medusa core version that includes the `cartFieldsForRefreshSteps` fix from PR #10090. As a stronger guard, add a custom validation step or a subscriber on order placed that re-checks `sales_channel_id` rules and only ever tightens a misconfigured rule going forward. Never rewrite historical orders based on this report; a human decides what, if anything, needs a manual adjustment.

## Test

```bash
pytest promotion-ignores-channel-condition/python
node --test promotion-ignores-channel-condition/node
```
