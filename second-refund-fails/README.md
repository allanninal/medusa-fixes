# Only one refund per order or payment ever succeeds

Medusa v2's refund-payment workflow historically validates a refund request
against the order's cached `summary.pending_difference`, an order-level
outstanding balance, instead of re-summing that specific payment's actual
captures minus its existing refunds. The first refund on an order correctly
zeroes out or flips the sign of that order-level balance, so
`validate-refund-step` throws "Order does not have an outstanding balance to
refund" on every refund attempt after that, even though the payment itself
may still have capturable or refundable amount left. A related bug
(`captured_amount` not updating correctly after capture with custom or
two-step payment providers, tracked as issue #11766) can make the order's
bookkeeping stale before any refund even happens.

This script lists orders with `payment_collections`, their `payments`, and
each payment's `captures` and `refunds` expanded, and for every payment runs a
pure decision function, `compute_refund_shortfall` (Python) /
`computeRefundShortfall` (Node), that sums `captures[].raw_amount` and
`refunds[].raw_amount` independently of the order's own summary. A payment is
flagged `isSilentlyBlocked` only when it still has a real shortfall
(`capturedTotal - refundedTotal > epsilon`) while the order's own
`pending_difference` already reads zero or negative, which is exactly the
condition that makes the order-level check reject a legitimate refund.

This never auto-fires a refund. A refund is real money moving through a
payment provider, so under `DRY_RUN` (the default) the script only logs the
computed shortfall and the target payment id and order id. Only with
`DRY_RUN=false`, after a human has reviewed and approved the flagged list,
does it call `POST /admin/payments/{payment_id}/refund` for the exact
shortfall already confirmed on the payment's own ledger. Confirm the store is
running a Medusa release that includes PR #11832 before flipping `DRY_RUN`
off, since an unpatched store rejects the corrective refund with the same
validation error. On an unpatched store, report the flagged list for manual
processing directly in the payment provider's dashboard instead.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/second-refund-fails/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python second-refund-fails/python/refund_shortfall.py
node   second-refund-fails/node/refund-shortfall.js
```

`compute_refund_shortfall` (Python) / `computeRefundShortfall` (Node) is a
pure function: given a payment's `captures` and `refunds` arrays plus the
order's own cached `pending_difference`, it sums `captures[].raw_amount` into
`capturedTotal`, sums `refunds[].raw_amount` into `refundedTotal`, computes
`shortfall = capturedTotal - refundedTotal`, and sets `isSilentlyBlocked =
shortfall > epsilon && pendingDifference <= epsilon`. It takes no network
calls, no SDK, just plain data, so it is deterministic and fully
unit-testable. Start with `DRY_RUN=true` to review the full flagged list
before writing anything.

## Test

```bash
pytest second-refund-fails/python
node --test second-refund-fails/node
```
