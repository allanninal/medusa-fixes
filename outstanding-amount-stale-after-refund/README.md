# Outstanding amount stale after refund

`outstanding_amount` is a derived field on a Medusa v2 order's `summary`, computed by the totals module from `order_transaction` rows, not a value that gets decremented directly. The first refund on an order inserts a new transaction row and the summary recomputes correctly, but a second `refundPaymentsWorkflow` run on the same order or payment does not insert another row, so the summary is never recomputed again and `outstanding_amount` freezes while the payment provider keeps processing more refunds underneath it.

There is no safe field to PATCH here, so this script only detects and flags. It pulls every order with its summary, payments, and refunds expanded, recomputes the true outstanding amount from the captures and refunds Medusa already recorded, and flags any order where that diverges from the cached summary. It never calls the refund endpoint again, since that would trigger the exact repeat-refund failure mode being diagnosed.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/outstanding-amount-stale-after-refund/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python outstanding-amount-stale-after-refund/python/detect_stale_outstanding.py
node   outstanding-amount-stale-after-refund/node/detect-stale-outstanding.js
```

`detect_stale_outstanding` is a pure function: it takes an order's total, its captures, its refunds, and the reported `outstanding_amount`, and computes the true outstanding amount as `total - sum(captures) + sum(refunds)`. It flags an order only when there is more than one refund event and the reported number disagrees with the true one by more than a cent (an epsilon for decimal and BigNumber rounding). The script never writes to Medusa under any `DRY_RUN` value, it only logs a finding per affected order with the computed true outstanding value, the reported value, and the refund ids and amounts behind it, so a human can reconcile through the Medusa admin dashboard's Order, Payment, Refund panel.

## Test

```bash
pytest outstanding-amount-stale-after-refund/python
node --test outstanding-amount-stale-after-refund/node
```
