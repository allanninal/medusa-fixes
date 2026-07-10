# Wrong currency shown for a region

A merchant sets a region's currency to INR and adds INR prices, but the storefront
keeps showing EUR. A Region has exactly one `currency_code`, but the price a customer
sees comes from a separate Pricing Module record: a `price` row on a `price_set`
linked to the variant. `calculated_price` resolves the region's `currency_code` and
filters the price set for a matching row. If the region's currency changed after
prices were seeded, if a price list scoped to another currency is still active, or if
no price exists for the region's real currency, the resolver falls through to a
different currency and the storefront renders it under the region's symbol.

This script never auto-converts an amount. Silently applying an FX rate to guess the
right number would corrupt real prices. It only ever writes a price row in the one
confirmed, unambiguous case: a variant is missing a row for the region's currency and
a human has already verified the amount via `CONFIRMED_AMOUNTS`. Every other finding,
including any real FX discrepancy, is reported only.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/wrong-currency-shown-for-a-region/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"
# Optional: only used for the narrow missing_currency_row repair case, after a
# human has verified the amount for that variant and currency.
export CONFIRMED_AMOUNTS="variant_01ABC:inr:1499.00"

python wrong-currency-shown-for-a-region/python/find_currency_mismatches.py
node   wrong-currency-shown-for-a-region/node/find-currency-mismatches.js
```

`find_currency_mismatches` (Python) / `findCurrencyMismatches` (Node) is a pure
decision function: it takes a region and the variant prices already fetched, and
returns a list of findings. A variant is flagged `calculated_mismatch` when the price
the storefront actually resolved does not match the region's currency, or
`missing_currency_row` when no raw price row for that currency exists at all. Only
`missing_currency_row` findings with a confirmed amount are ever written, and only
when `DRY_RUN=false`. Start with `DRY_RUN=true` to review the full report first.

## Test

```bash
pytest wrong-currency-shown-for-a-region/python
node --test wrong-currency-shown-for-a-region/node
```
