# Shipping discount uses a stale shipping amount after cart changes

In Medusa v2, adding or updating a cart item runs `refreshCartItemsWorkflow`,
which triggers `refreshCartShippingMethodsWorkflow` to recalculate the price
of any calculated shipping option, and separately runs
`updateCartPromotionsWorkflow` to recompute promotion adjustments. Because
those are two independent workflow steps that each fetch and pass cart state
on their own, the promotion module's `computeActions` for shipping methods
can compute the percentage-off amount against the shipping method's amount
as it stood before the shipping refresh step's change becomes visible. The
result is a `ShippingMethodAdjustment` whose `amount` reflects the old
shipping price, not the new one ([medusajs/medusa#14484](https://github.com/medusajs/medusa/issues/14484)).

This script reads a cart's shipping methods, their adjustments, and applied
promotions, fetches each promotion's live `application_method` rule, and runs
a pure function, `compute_expected_shipping_adjustment` /
`computeExpectedShippingAdjustment` (wrapped by `evaluate_stale_adjustment` /
`evaluateStaleAdjustment`), that computes what the adjustment should be right
now from the current shipping amount. Where the stored amount disagrees past
a small tolerance, the cart is flagged. It never writes
`ShippingMethodAdjustment.amount` directly. The only write it can make, and
only outside dry run, is re-applying the same promotion codes through the
store API's cart promotions route, which forces Medusa's own
`updateCartPromotionsWorkflow` to recompute the adjustment for real. Orders
that already completed with the stale amount are not auto-corrected, since
rewriting a captured total is unsafe to automate; flag them for a manual
refund or credit instead.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/shipping-discount-stale-amount/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export CART_IDS="cart_01,cart_02"
export DRY_RUN="true"

python shipping-discount-stale-amount/python/reconcile_shipping_discount.py
node   shipping-discount-stale-amount/node/reconcile-shipping-discount.js
```

Start with `DRY_RUN=true` to review the exact list of flagged carts, their
shipping method, promotion code, stored amount, expected amount, and delta.
Set `DRY_RUN=false` only once you have reviewed the list, and the script will
re-apply the promotion codes on each flagged cart, one cart at a time, so
Medusa recomputes the adjustment against the current shipping amount.

## Test

```bash
pytest shipping-discount-stale-amount/python
node --test shipping-discount-stale-amount/node
```
