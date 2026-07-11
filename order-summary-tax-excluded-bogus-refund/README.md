# Order summary drops tax from totals, triggering bogus refunds

In Medusa v2, confirmed on v2.10.1, the order summary's derived totals, `summary.accounting_total`, `summary.current_order_total`, and `summary.pending_difference`, are computed from `subtotal + shipping_total`, leaving `tax_total` out of the math entirely, even though the authoritative `order.total` field is computed correctly. A customer who paid the full, correct `order.total` on a tax-inclusive order looks, to the summary, like they overpaid by exactly the tax amount. Anything wired to `pending_difference`, an automation, a reconciliation job, an order-edit "refund the difference" action, can issue a refund for money nobody actually overpaid.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/order-summary-tax-excluded-bogus-refund/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python order-summary-tax-excluded-bogus-refund/python/detect_tax_dropped_from_summary.py
node   order-summary-tax-excluded-bogus-refund/node/detect-tax-dropped-from-summary.js
```

`detect_tax_dropped_from_summary` is a pure function: an order is flagged only when it has real tax (`tax_total > 0`) and the drift between `order.total` and `summary.accounting_total` lands within a cent of `tax_total`, the exact signature of this bug rather than a rounding artifact or a real partial refund. It always returns a `correctedPendingDifference`, computed as `order.total - summary.paid_total`, as the trustworthy replacement for the buggy field. The script never issues a refund or a recharge. When a bogus refund already fired and `DRY_RUN=false`, the only write is a metadata flag (`flagged_tax_refund_drift`, `expected_manual_recharge`) on the order, left for a human to review and manually re-invoice if needed. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest order-summary-tax-excluded-bogus-refund/python
node --test order-summary-tax-excluded-bogus-refund/node
```
