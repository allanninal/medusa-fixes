# Editing an order cancels its payment collection

In Medusa v2, a regression introduced in 2.7 and tracked as GitHub issue `#12200` makes the order edit workflow (`beginOrderEditOrderWorkflow` / `updateOrderEditOrderWorkflow` into `confirmOrderEditRequestWorkflow`) treat any quantity or unit price change as invalidating the order's existing totals. As part of recalculating, it cancels the order's current `payment_collection` and resets `payment_status` to `not_paid`, expecting a fresh collection to be created for the new amount owed. That new collection does not always get created and attached, especially on force-confirmed admin edits made with the manual payment provider, so the order is left with only a permanently canceled collection that `capturePaymentWorkflow` refuses to act on.

This script lists orders with a confirmed edit, classifies each one with a pure function, and reports every order that is blocked by a canceled payment collection with an outstanding balance. It never mutates the canceled collection and never auto-creates a replacement, since there is no supported route to un-cancel a `payment_collection` and a silent replacement risks desyncing `order.summary`.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/order-edit-cancels-payment-collection/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python order-edit-cancels-payment-collection/python/flag_edit_cancels_payment.py
node   order-edit-cancels-payment-collection/node/flag-edit-cancels-payment.js
```

`classify_order_payment_edit_state` (Python) / `classifyOrderPaymentEditState` (Node) is a pure function: no network or database calls. It returns `blocked: true` only when `payment_status` is `not_paid`, no `payment_collection` has a capturable status (`not_paid`, `awaiting`, `authorized`, `partially_authorized`), at least one `payment_collection` is `canceled`, and the outstanding amount (`summary.raw_difference_due`, or a fallback sum of uncaptured collection amounts) is greater than 0. A healthy order, an order with an active collection, and a fully refunded or canceled order with no amount due are never flagged.

`DRY_RUN=true` (the default) only reports the affected orders, order id, display id, the canceled collection id, and the amount due. It never writes anything. Even with `DRY_RUN=false`, the script does not auto-create a payment collection or auto-capture; that is a deliberate design choice. Only after a human confirms the amount due against `order.summary.raw_difference_due` should a new payment collection be created with `POST /admin/orders/:id/payment-collections`, a payment session attached with `POST /admin/payment-collections/:collection_id/payment-sessions`, and the resulting payment captured with `POST /admin/payments/:payment_id/capture`.

## Test

```bash
pytest order-edit-cancels-payment-collection/python
node --test order-edit-cancels-payment-collection/node
```
