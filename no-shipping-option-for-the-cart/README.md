# No shipping option for the cart

Shipping availability for a Medusa v2 cart is resolved by walking cart to
sales channel to stock location to FulfillmentSet to ServiceZone to GeoZone,
matching the cart's `shipping_address.country_code` against a GeoZone. Only
shipping options that belong to a matching service zone are returned.
Regions, which control checkout availability and currency, are configured
independently of service zone geo zones, so a merchant can add a country to
a Region without ever adding a matching GeoZone to any ServiceZone, or
without linking the right stock location to the sales channel. The result is
`GET /store/shipping-options/{cart_id}` returning an empty array for that
country, even though the region, product, and pricing all look correct.

This script lists every region's countries per sales channel, flattens every
geo zone reachable from that channel's stock locations, and diffs the two
sets with a pure decision function. It reports every uncovered
(sales_channel, country) pair, along with whether the gap is a missing geo
zone match or a matched service zone with no usable shipping option. It does
not create service zones, geo zones, or shipping options automatically,
since which countries to ship to, carrier rates, and tax nexus are business
decisions for a human to make.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/no-shipping-option-for-the-cart/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"

# Optional: only needed to enable the guarded repair path.
export FULFILLMENT_SET_ID=""   # fulset_...
export SERVICE_ZONE_ID=""      # serzone_...
export SHIPPING_PROFILE_ID=""  # sp_...
export PROVIDER_ID=""          # e.g. manual_manual

export DRY_RUN="true"

python no-shipping-option-for-the-cart/python/find_uncovered_regions.py
node   no-shipping-option-for-the-cart/node/find-uncovered-regions.js
```

`find_uncovered_regions` / `findUncoveredRegions` is a pure function: for
each region's (sales channel, country) pair, it collects every country
covered by a geo zone reachable from that channel's stock locations. If none
match, it reports `no_geo_zone_match`. If a matching service zone exists but
its shipping options are empty, or every option's rules would exclude a
baseline cart (for example a minimum subtotal rule), it reports
`zone_matched_no_shipping_options`. Covered pairs are omitted from the
result.

The script itself is report only by default. If `FULFILLMENT_SET_ID`,
`SERVICE_ZONE_ID`, `SHIPPING_PROFILE_ID`, and `PROVIDER_ID` are all set, it
prints the exact planned `POST /admin/fulfillment-sets/{id}/service-zones/{id}/geo-zones`
call for each gap, and only executes it when `DRY_RUN=false`. Always confirm
the fix by calling `GET /store/shipping-options/{cart_id}` for a synthetic
cart in that country and checking for a non-empty array before trusting
checkout again.

## Test

```bash
pytest no-shipping-option-for-the-cart/python
node --test no-shipping-option-for-the-cart/node
```
