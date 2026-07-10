# Refund not reflected on the order

In Medusa v2, orders and payments are separate modules joined only through
module links. An order's displayed totals, `summary.paid_total`,
`refunded_total`, and `accounting_total`, are a cached snapshot that only
recomputes when a refund is applied through the official
`refundPaymentsWorkflow`, the same workflow behind the admin Refund action. If
a refund is instead recorded directly against the Payment module, for example
by a custom or manual payment provider's own `refund()` implementation, or a
provider webhook firing outside the workflow, the Payment module's ledger
updates but no `OrderChange` is created, so the order's summary never
recalculates. The refund is real and the money moved, but the order still
shows the pre-refund paid and outstanding amounts.

This script lists orders with `payment_collections`, their `payments`, and
each payment's `refunds` expanded, sums every payment's real refund ledger,
and compares that against `order.summary.refunded_total` with a pure decision
function, `decide_refund_reconciliation` (Python) / `decideRefundReconciliation`
(Node). Only orders where the ledger is ahead of the order (`refund_not_reflected`)
are resynced, and only by calling the same route the admin Refund button uses,
`POST /admin/payments/{payment_id}/refund`, with the exact delta already
confirmed on the Payment module side, never a guessed or recomputed amount.
Orders where the order shows more refunded than the ledger
(`over_refunded_on_order`) are flagged for manual review and never
auto-repaired, since that direction risks masking a real problem or causing a
duplicate refund against a provider that already refunded out of band.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/refund-not-reflected-on-the-order/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python refund-not-reflected-on-the-order/python/reconcile_refunds.py
node   refund-not-reflected-on-the-order/node/reconcile-refunds.js
```

`decide_refund_reconciliation` (Python) / `decideRefundReconciliation` (Node)
is a pure decision function: given an order with its `summary` and
`payment_collections`, it flattens every payment across every collection,
sums `refunds[].amount` into `ledgerRefundedTotal` (the Payment module's own
truth), reads `orderRefundedTotal` from `order.summary.refunded_total` (what
the order and UI trust), and computes `delta = ledgerRefundedTotal -
orderRefundedTotal`. A `delta` greater than an epsilon of `0.01` returns
`needsSync: true` with reason `"refund_not_reflected"`. A `delta` less than
`-0.01` returns `needsSync: true` with reason `"over_refunded_on_order"`,
which the runner only ever flags, never repairs. Otherwise it returns
`"in_sync"`. After a real resync, the script re-fetches the order and
confirms `summary.refunded_total` now matches the ledger total before
counting the order as fixed. Start with `DRY_RUN=true` to review the full
list before writing anything.

## Test

```bash
pytest refund-not-reflected-on-the-order/python
node --test refund-not-reflected-on-the-order/node
```
