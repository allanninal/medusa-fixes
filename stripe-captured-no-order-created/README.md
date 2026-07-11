# Stripe capture succeeds but no Medusa order is created

Stripe's dashboard shows a captured PaymentIntent, but the cart it was paid against never became a Medusa order. This happens when `completeCartWorkflow` never runs, usually because the browser tab or network dropped between the client-side Stripe confirmation and the storefront's `POST /store/carts/{id}/complete` call, or because the async `payment_intent.succeeded` webhook raced ahead of that call. This reconciler cross-references recent Stripe PaymentIntents against Medusa's `/admin/payments`, flags orphaned captures, and behind a `DRY_RUN` guard repairs them by retrying the same cart completion route the storefront already calls.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/stripe-captured-no-order-created/

## Run it

```bash
export STRIPE_SECRET_KEY="sk_live_..."
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export GRACE_MINUTES="10"
export DRY_RUN="true"

python stripe-captured-no-order-created/python/reconcile_orphaned_captures.py
node   stripe-captured-no-order-created/node/reconcile-orphaned-captures.js
```

`decide_reconciliation` / `decideReconciliation` is a pure function (all timestamps and lookups are passed in): a Stripe PaymentIntent is flagged as an orphaned capture only when it is `succeeded`, older than the grace window, has no matching `payment.data.id` in Medusa, and its cart has neither `completed_at` nor a resolved order. The only write in repair mode is retrying `POST /store/carts/{id}/complete`, the exact route the storefront calls after checkout, never a synthetic order insert through the Admin API. Start with `DRY_RUN=true` to review the flagged list first.

## Test

```bash
pytest stripe-captured-no-order-created/python
node --test stripe-captured-no-order-created/node
```
