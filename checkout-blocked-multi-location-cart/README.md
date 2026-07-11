# Checkout blocked for carts split across stock locations

Medusa v2's confirm-inventory preparation step, `prepare-confirm-inventory-input.ts`,
merges every line item's valid stock locations into one flattened list instead of
keeping each item's valid locations scoped to itself. The `reserve-inventory` step
then picks the first location in that merged list and tries to reserve every item
there, so an item only stocked at a different location fails to reserve, even though
the channel has enough total stock (known upstream bug, [medusajs/medusa#10561](https://github.com/medusajs/medusa/issues/10561)).
This script reads a stuck cart's items and their real per-location stock, computes
each item's own valid locations, and flags the cart when no single location covers
every item though each item has stock somewhere.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/checkout-blocked-multi-location-cart/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export CART_ID="cart_..."
export DRY_RUN="true"

python checkout-blocked-multi-location-cart/python/detect_multi_location_cart.py
node   checkout-blocked-multi-location-cart/node/detect-multi-location-cart.js
```

`resolve_item_locations` and `is_affected_cart` are pure functions (levels and
channel location ids are passed in as plain data): `resolve_item_locations`
filters each item's location levels down to the channel-linked locations with
enough available stock (`stocked_quantity - reserved_quantity`), and
`is_affected_cart` flags a cart only when every item has at least one valid
location of its own but no single location is valid for every item at once,
the exact signature of this bug. Auto-repair is unsafe, since Medusa v2 has no
supported endpoint to force per-item reservation at cart completion, so the
only write is an optional, `DRY_RUN`-guarded manual reservation per item at its
own correct location, meant as a one-off mitigation while you upgrade past the
bug. Start with `DRY_RUN=true` to review the flagged carts first.

## Test

```bash
pytest checkout-blocked-multi-location-cart/python
node --test checkout-blocked-multi-location-cart/node
```
