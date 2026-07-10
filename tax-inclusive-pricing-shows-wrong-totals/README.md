# Tax-inclusive pricing shows wrong totals

Whether a price is tax-inclusive is not one global flag in Medusa v2. It is decided
per calculation context by a `PricePreference` keyed on `region_id` or
`currency_code`, and the same `includes_tax` concept is set again independently on
`Region`, `Currency`, `PriceList`, and `ShippingOption`. Because those settings are
configured in different admin screens, they can drift out of sync, for example a
region turns tax-inclusive pricing on but a shipping option price for that region was
created before the switch. `calculatePrices` then resolves
`is_calculated_price_tax_inclusive` inconsistently across line items, and the cart or
order totals stop reconciling: `subtotal + tax_total` no longer equals `total`.

This script never rewrites an order's totals or a price amount directly. Those must be
recalculated by Medusa's own totals workflow. It only ever writes the specific
`PricePreference` a human has approved via `APPLY_FIX_FOR`. Every other finding is
reported only.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/tax-inclusive-pricing-shows-wrong-totals/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"
# Optional: only used for the one human-approved PricePreference write.
export APPLY_FIX_FOR="region_id:reg_01ABC:true"

python tax-inclusive-pricing-shows-wrong-totals/python/find_tax_inclusivity_mismatches.py
node   tax-inclusive-pricing-shows-wrong-totals/node/find-tax-inclusivity-mismatches.js
```

`find_tax_inclusivity_mismatches` (Python) / `findTaxInclusivityMismatches` (Node) is a
pure decision function: it takes the fetched `PricePreference` records and the price
contexts from price lists and shipping options, and returns a list of mismatches. A
context is flagged with reason `"region/currency preference conflict"` when both a
region preference and a currency preference exist and disagree, or with
`"no preference configured, defaults may drift"` when neither exists at all. The
script also spot-checks recent orders for `subtotal + tax_total + shipping_total`
not reconciling with `total`. The only write is `POST /admin/price-preferences` for
the one context a human names in `APPLY_FIX_FOR`, and only when `DRY_RUN=false`.
Start with `DRY_RUN=true` to review the full report first.

## Test

```bash
pytest tax-inclusive-pricing-shows-wrong-totals/python
node --test tax-inclusive-pricing-shows-wrong-totals/node
```
