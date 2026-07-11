# Order edit after capture computes the refund direction backwards

In Medusa v2, an order's `summary.pending_difference` is meant to equal `current_order_total - paid_total`: negative means a refund is owed to the customer, positive means the customer still owes more. GitHub issues `#13068` and `#13067` report that once a payment has already been captured, the summary's `paid_total` is not correctly reflected before an order edit's new totals are diffed against it, so the recomputed difference can effectively swap the operands and flip the sign. A customer who swapped into a cheaper variant, and who is owed a refund, can end up with the order reporting an amount to collect instead.

This script lists paid orders with a pending or confirmed edit, recomputes the expected balance direction with a pure function, and reports every order where that recomputed direction disagrees with what the app or UI is using. It never mutates order data and never calls a capture or refund route, since this is a computed field bug in Medusa core, not corrupted data.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/order-edit-wrong-balance-direction/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python order-edit-wrong-balance-direction/python/flag_wrong_balance_direction.py
node   order-edit-wrong-balance-direction/node/flag-wrong-balance-direction.js
```

`decide_balance_action` (Python) / `decideBalanceAction` (Node) is a pure function: no network or database calls. It takes `current_order_total` and `paid_total`, computes `current_order_total - paid_total`, and returns `direction: "refund"` when negative, `"collect"` when positive, and `"none"` when zero. That is the exact operand order the regression in `#13068` gets backwards, so the function is written to make that mistake structurally impossible to repeat, and the test suite asserts that swapping the two arguments flips the sign.

`DRY_RUN=true` (the default) only reports the affected orders: order id, display id, the reported direction, the recomputed expected direction, `paid_total`, `current_order_total`, and the recomputed `pending_difference`. It never writes anything. Even with `DRY_RUN=false`, the script does not touch payments or confirm the edit; its only write is an `internal_note` on the order edit via `POST /admin/order-edits/{id}` naming the suspected bug and asking for manual verification. A human must confirm the correct direction from the recomputed `pendingDifference` sign before triggering `POST /admin/order-edits/{id}/confirm` and the corresponding capture or refund action.

## Test

```bash
pytest order-edit-wrong-balance-direction/python
node --test order-edit-wrong-balance-direction/node
```
