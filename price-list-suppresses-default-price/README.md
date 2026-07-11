# A price list suppresses all default variant prices once active

Medusa v2's pricing module resolves `calculated_price` by first checking
whether any price list price matches the given context, such as region,
currency, or a customer group rule. Once at least one valid price list price
exists for a price set, the price-selection strategy restricts its candidate
pool to price list scoped prices and never falls back to compare against the
variant's default, no price list prices, even when the price list's own
`rules` do not actually apply to the current shopper or the default price is
cheaper. This is a known Medusa core bug
([medusajs/medusa#10613](https://github.com/medusajs/medusa/issues/10613)),
not a per-record data mistake, so it is not safe to fix by mutating store
data or by blindly deactivating price lists.

This script lists active price lists, resolves the variants and default
prices behind them, requests `calculated_price` in the relevant region and
currency context, and reports every variant and currency where the default
price was wrongly suppressed, either because the price list's rules did not
match the request context, or because the price list amount was higher than
the default it should have fallen back to.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/price-list-suppresses-default-price/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_REGION_ID="reg_01..."
export MEDUSA_CURRENCY_CODE="usd"
export DRY_RUN="true"

python price-list-suppresses-default-price/python/find_suppressed_default_price.py
node   price-list-suppresses-default-price/node/find-suppressed-default-price.js
```

`is_default_price_wrongly_suppressed` (Python) / `isDefaultPriceWronglySuppressed`
(Node) is a pure function: it takes the calculated price result, the price
list's `rules`, the request context (`customer_group_ids` among other
fields), and the resolved default amount for the currency, and returns a
plain decision with no I/O.

- If the calculated price did not come from a price list at all, never
  flagged.
- If there is no default price to compare against for that currency, never
  flagged, there is nothing to fall back to.
- If the price list's rules do not intersect the request context (for
  example the customer group does not match) yet the price list price was
  still used, flagged as `rules_mismatch`.
- Otherwise, if the calculated amount is higher than the default amount, the
  cheaper default should have won: flagged as `higher_than_default`.

This script only reports. It never edits, deletes, or deactivates a price
list on its own, since a price list can be a legitimate promotion the
merchant still wants active for its correctly scoped audience. Where a
workaround is wanted, the safe repair is to add an explicit price row on the
price list itself, scoped to the same currency, so the list's own price
becomes the correct one served. Start with `DRY_RUN=true` to only report.

## Test

```bash
pytest price-list-suppresses-default-price/python
node --test price-list-suppresses-default-price/node
```
