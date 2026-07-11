# Region scoped price ignored in favor of currency only price

Medusa v2's Pricing Module resolves `calculated_price` by first looking
for a Price row whose rule set is an exact, complete match for the
request context (`region_id`, `currency_code`, and so on). When a
variant carries both a region scoped price and a plain currency only
price, and nothing satisfies every rule at once, the resolver falls
back to the price matching the most rules, and ties or partial-match
edge cases resolve toward the plain currency only row instead of the
region scoped one. Community reports such as
[medusajs/medusa#13120](https://github.com/medusajs/medusa/issues/13120)
confirm `calculated_price` frequently returns the currency only
default, or even null, once a variant has any `region_id` rule on one
of its prices, even with the correct `region_id` and `currency_code`
passed in the request context.

The data is stored correctly, so this is flag-and-report, not
auto-repair: it lists regions, walks every product and variant,
groups each variant's prices by currency to find the ones carrying
both a region scoped row and a currency only row, computes which
price should win with a pure ranking function, and cross-checks that
against what the Store API's `calculated_price` actually serves. Any
mismatch is logged with both price ids so a human can review it and
apply the documented workaround. Nothing is rewritten automatically.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/region-price-ignored/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export DRY_RUN="true"

python region-price-ignored/python/find_ignored_region_price.py
node   region-price-ignored/node/find-ignored-region-price.js
```

`pick_winning_price` (Python) / `pickWinningPrice` (Node) is a pure
decision function: given a variant's prices and a request context of
`region_id` and `currency_code`, it filters to prices whose every rule
is satisfied by the context and whose `currency_code` matches, ranks
survivors by the number of matched rules, then by total rule count,
then prefers rows that explicitly carry a `region_id` rule, and
returns the top candidate or `None`/`null`. It takes no I/O, so it is
fully unit-testable with fixture prices and no running Medusa
instance or network call. This is the exact branch reproducing issue
#13120: a region-plus-currency price must outrank a currency-only
price for the same `currency_code` and matching `region_id`.

`has_region_and_currency_only_pair` / `hasRegionAndCurrencyOnlyPair`
is the pure filter that decides which variant/region pairs are even
worth cross-checking against the Store API. The script only ever
reads. If it flags a variant and region, the documented workaround is
to add an explicit `currency_code` condition alongside the existing
`region_id` rule on that Price row, since a price matching both rules
outranks a currency only price in the resolver's own ranking. Apply
that change by hand, then re-run this script to confirm
`calculated_price` now returns the region scoped price's id.

## Test

```bash
pytest region-price-ignored/python
node --test region-price-ignored/node
```
