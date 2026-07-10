# Cart completion fails, no payment provider

Completing a Medusa v2 cart creates or reuses a `payment_collection` and asks
the region's linked payment providers to open a payment session. A payment
provider only shows up for a region when it is registered in
`medusa-config`, linked to that region in the Admin, and able to
authenticate with its own credentials. A merchant can set up a region with
the right currency and countries and never link a payment provider, or link
one that is not actually registered, or link one whose credentials are
invalid. In every case the cart builds fine through pricing and shipping,
and only fails once checkout tries to complete.

This script lists every region, lists the payment providers actually
registered and enabled for that region, and diffs the two sets with a pure
decision function. It reports every region with no linked payment provider
at all, or with linked providers that are all missing from the enabled set.
It does not link a payment provider automatically, since which gateway to
offer in which market is a business and compliance decision for a human to
make.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/cart-completion-fails-no-payment-provider/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"

# Optional: only needed to enable the guarded repair path.
export TARGET_PROVIDER_ID=""   # e.g. pp_stripe_stripe

export DRY_RUN="true"

python cart-completion-fails-no-payment-provider/python/find_regions_without_payment.py
node   cart-completion-fails-no-payment-provider/node/find-regions-without-payment.js
```

`find_regions_without_working_payment` / `findRegionsWithoutWorkingPayment`
is a pure function: for each region, it checks the ids the region has
linked against the ids the backend actually reports as enabled for that
region. If nothing is linked, it reports `no_provider_linked`. If something
is linked but none of it is in the enabled set, it reports
`linked_provider_not_enabled`, which covers both an unregistered module and
a provider whose own credentials fail. Regions with a working provider are
omitted from the result.

The script itself is report only by default. If `TARGET_PROVIDER_ID` is
set, it prints the exact planned `POST /admin/regions/{id}` call for each
gap, and only executes it when `DRY_RUN=false`. Always confirm the fix by
re-listing the region's payment providers, or by completing a real cart in
that region, before trusting checkout again.

## Test

```bash
pytest cart-completion-fails-no-payment-provider/python
node --test cart-completion-fails-no-payment-provider/node
```
