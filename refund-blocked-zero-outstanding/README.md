# Refund blocked on a captured order showing zero outstanding

In Medusa v2, the Admin dashboard's Refund action and most custom refund code check the order's derived `summary` fields, `paid_total`, `refunded_total`, and `outstanding_amount`, instead of the actual captured amount on the Payment module record. When that summary is computed or cached incorrectly after a capture, for example with a custom payment provider, multiple payment collections, or rounding in totals recalculation, it can read `outstanding_amount` as zero while the payment is still fully refundable, and the guard throws "Order does not have an outstanding balance to refund" on a perfectly legitimate refund.

This script lists captured, non-refunded orders with their payments expanded, computes the true refundable amount as `payment.amount` minus `payment.amount_refunded` straight from the Payment module, re-confirms it right before writing, and calls the refund route directly, bypassing the unreliable order-summary gate. It never trusts `outstanding_amount` as the blocking condition, only as a diagnostic signal to flag for audit.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/refund-blocked-zero-outstanding/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python refund-blocked-zero-outstanding/python/refund_from_ledger.py
node   refund-blocked-zero-outstanding/node/refund-from-ledger.js
```

`decide_refund` is a pure function: it takes a payment, the order's summary, and a requested amount, and returns whether the refund is allowed and how much is truly refundable. It trusts `payment.amount` minus `payment.amount_refunded` as the source of truth, and specifically allows the refund when the order's summary reads zero or negative outstanding but the payment is still captured and refundable, tagging that case with the reason `summary_outstanding_zero_but_payment_captured` so it can be audited. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest refund-blocked-zero-outstanding/python
node --test refund-blocked-zero-outstanding/node
```
