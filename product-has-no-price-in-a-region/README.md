# Product has no price in a region

A region in Medusa v2 has exactly one `currency_code`, and a variant is only
purchasable in that region if its price set holds a `Price` record in that
same currency. Nothing forces every variant to carry a price for every
currency your regions use, so a new region, or a variant added after regions
were configured, can easily end up with no matching price. This script lists
every region and every product's variants, then reports every variant and
region pair that is missing a price, before a customer runs into a null
`calculated_price` at checkout.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/product-has-no-price-in-a-region/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python product-has-no-price-in-a-region/python/find_missing_region_prices.py
node   product-has-no-price-in-a-region/node/find-missing-region-prices.js
```

`find_missing_region_prices` is a pure function: it takes an array of
variants and an array of regions and returns every gap, with no I/O. For
each variant it builds the set of currencies it has a price for, then for
each region checks whether that region's currency is in the set. An empty
result means the catalog is fully priced. Filling a gap is a separate,
human-approved step, since picking an amount for a new currency is a
pricing decision, not something a script should guess. Start with
`DRY_RUN=true` to only report gaps.

## Test

```bash
pytest product-has-no-price-in-a-region/python
node --test product-has-no-price-in-a-region/node
```
