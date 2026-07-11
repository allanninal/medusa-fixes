# Draft orders cannot get a payment collection created

In Medusa v2, a draft order is an Order module record created directly through the draft-order workflows, with `is_draft_order: true` and no `cart_id` attached. The store-facing route, `POST /store/payment-collections`, is cart-centric and expects a `cart_id`, so it cannot create one for a draft order. Medusa maintainers confirmed on GitHub issue `#14501` that this is expected behavior, not a bug. The correct mechanism is `createOrUpdateOrderPaymentCollectionWorkflow`, exposed through `POST /admin/draft-orders/:id/payment-collections`, which links a payment collection to the order through the `order_payment_collection` table using `order_id`, bypassing the cart entirely.

This script lists draft orders, classifies each one with a pure function, and reports every draft order that is stuck with no payment collection and a positive outstanding amount. It never calls the cart-centric route for a draft order. Only when `DRY_RUN=false` does it create the order-linked payment collection and mark it paid.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/draft-order-no-payment-collection/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python draft-order-no-payment-collection/python/fix_draft_order_payment.py
node   draft-order-no-payment-collection/node/fix-draft-order-payment.js
```

`decide_draft_order_payment_action` (Python) / `decideDraftOrderPaymentAction` (Node) is a pure function: no network or database calls. It returns `"OK"` when the order is not a draft order, is already `completed`, already has a payment collection, or has nothing pending. It returns `"FLAG_STUCK_NO_PAYMENT"` when a draft order has no payment collection, a positive pending amount, and no cart_id, which is the normal shape of every real draft order. It returns `"NEEDS_ORDER_PAYMENT_COLLECTION"` only in the hypothetical case a cart_id is present.

`DRY_RUN=true` (the default) only reports the affected draft orders, order id, display id, and pending amount. It never writes anything. Only when `DRY_RUN=false` does the script call `POST /admin/draft-orders/:id/payment-collections` to create the order-linked payment collection, then `POST /admin/payment-collections/:id/mark-as-paid` to complete it, the same "Mark as paid" action exposed in the Admin dashboard.

## Test

```bash
pytest draft-order-no-payment-collection/python
node --test draft-order-no-payment-collection/node
```
