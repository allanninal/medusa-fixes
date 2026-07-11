# Custom provider capture skips creating the order transaction

Medusa v2's checkout/capture flow expects a custom payment provider's `authorizePayment` to return `authorized`, after which `capturePaymentWorkflow` runs a step called `addOrderTransactionStep` that records the amount against the order. When a custom provider instead returns `captured` directly from `authorizePayment`, to signal an auto-captured payment such as cash on delivery or a synchronous gateway, Medusa marks the `Payment` record's `captured_at` but never calls that step. Because `order.summary.paid_total` is computed purely from `OrderTransaction` rows, not from `Payment.amount` or `Payment.captured_at`, the order is left showing the full amount outstanding even though the provider and the `Payment` entity both say it was captured.

This job lists orders with their payments and transactions, flags the ones where a captured payment has no matching `OrderTransaction` row, and reports the missing transaction. Only the single, unambiguous case, exactly one captured payment with no existing reference, is proposed for repair. Orders with multiple payments, partial reference coverage, or prior refunds are always flagged for manual review instead of being auto-repaired, since there is no public REST endpoint that inserts an order transaction directly; the actual write has to run server side inside the Medusa project, for example through a `medusa exec` script that resolves the order module and calls `createOrderTransactions`.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/custom-provider-capture-skips-transaction/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python custom-provider-capture-skips-transaction/python/find_missing_order_transactions.py
node   custom-provider-capture-skips-transaction/node/find-missing-order-transactions.js
```

`decide_order_transaction_repair` / `decideOrderTransactionRepair` is a pure function: given an order's `paid_total`, its payments, and the set of payment ids already referenced by an existing transaction, it returns `create_transaction`, `flag_ambiguous`, or `noop`. It only ever proposes `create_transaction` when there is exactly one captured, non-canceled payment missing its transaction reference and `paid_total` is short of the captured amount. Multiple captured payments, or a reference set that covers some but not all of them, always resolve to `flag_ambiguous`. In `DRY_RUN=true` mode the script only logs the reconciliation record it would write. In `DRY_RUN=false` mode it logs the exact `medusa exec` command to run inside your Medusa project to create the transaction, since that write cannot happen over the public Admin REST API. Start with `DRY_RUN=true` to review the list first, and have a human confirm any flagged order before writing.

## Test

```bash
pytest custom-provider-capture-skips-transaction/python
node --test custom-provider-capture-skips-transaction/node
```
