# Multiple customer group membership breaks price list resolution

A customer gets added to a second customer group and their price list discount silently stops applying, no error, no warning. Medusa v2's Pricing Module matches a price list's `customer.groups.id` rule against the group context passed into price calculation. With exactly one group on the customer that match works, but once a customer belongs to two or more groups, the matching query fails to find any group in the set, so the price list is skipped and pricing falls through to the base price (medusajs/medusa `#11875`, `#13034`). This is a pricing-engine matching bug, not a bad data row, so this script only detects and reports affected customers. It never mutates customer groups or price lists on its own.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/multi-group-price-resolution-fails/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export MEDUSA_REGION_ID="reg_..."
export DRY_RUN="true"

python multi-group-price-resolution-fails/python/detect_multi_group_price_mismatch.py
node   multi-group-price-resolution-fails/node/detect-multi-group-price-mismatch.js
```

`detect_stale_price_list_override` is a pure function: given the customer's group ids, a price list's `customer.groups.id` rule, the price actually resolved for that customer, and a control price resolved for a synthetic single-group customer, it flags a customer only when the price list rule should apply, the control customer received the override, and the real multi-group customer fell back to the default price instead. The script never edits a customer's groups or a price list's rules. It only reports `{customer_id, groups, expected_price_list_id, reason}` for each affected customer. `DRY_RUN` gates even the log wording around a possible mitigation such as collapsing a customer to one group.

## Test

```bash
pytest multi-group-price-resolution-fails/python
node --test multi-group-price-resolution-fails/node
```
