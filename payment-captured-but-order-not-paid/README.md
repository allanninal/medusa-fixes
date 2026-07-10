# Payment captured but order not paid

In Medusa v2, an order's `payment_status` is not a stored field the capture call writes directly. It is derived from the order's `payment_collections` and their underlying Payment records, reconciled through the order's `summary` (`paid_total`, `transaction_total`, `pending_difference`). If the capture step succeeds against the provider but the linking step does not create the matching order transaction, or the `payment.captured` event is missed, the Payment shows `captured_at` set while the order never advances off `not_paid`. This script lists recently updated orders, sums each order's captured amounts with a pure function, flags any mismatch, and repairs it the safe way by re-invoking the capture route on the existing payment, never by writing status directly.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/payment-captured-but-order-not-paid/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python payment-captured-but-order-not-paid/python/reconcile_payment_status.py
node   payment-captured-but-order-not-paid/node/reconcile-payment-status.js
```

`detect_payment_status_mismatch` (Python) / `detectPaymentStatusMismatch` (Node) is a pure function: it sums `captures[].raw_amount.value` across every payment on every payment collection and flags the order as mismatched only when captured funds exist but `payment_status` is still `not_paid`/`awaiting`, or `summary.raw_paid_total` is 0 despite captured funds, or a payment collection's own status has not advanced past its captured payments. No network or database calls.

The repair step never writes `payment_status` directly, since it is derived and would just desync again. It re-invokes the Admin API's payment capture route (`POST /admin/payments/{id}/capture`) on the existing `payment_id`, which is idempotent because the payment is already captured provider side. If a mismatch survives the re-invoke, the script flags the order for a human instead of forcing a status write. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest payment-captured-but-order-not-paid/python
node --test payment-captured-but-order-not-paid/node
```
