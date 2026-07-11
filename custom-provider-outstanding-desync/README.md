# Custom provider capture leaves outstanding amount desynced

A custom Medusa v2 payment provider captures the money, the provider dashboard and the `Payment` record both agree, but the order's `summary.outstanding_amount` does not drop to match. `outstanding_amount` is derived as `current_order_total` minus `paid_total`, and `paid_total` is computed purely from `OrderTransaction` rows, never read from `Payment` directly. When a custom provider's capture path finishes without running the same order transaction step the built-in `capturePaymentWorkflow` always runs, the ledger never learns about the captured amount and the order keeps showing a balance due that was already collected.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/custom-provider-outstanding-desync/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python custom-provider-outstanding-desync/python/find_outstanding_desync.py
node   custom-provider-outstanding-desync/node/find-outstanding-desync.js
```

`decide_outstanding_repair` is a pure function: an order is only proposed for repair when it has exactly one non-canceled captured payment whose amount is not already covered by an `OrderTransaction` reference. Orders with more than one captured payment, or a reference set that only partially covers the captured payments, are flagged `flag_ambiguous` for a human to check instead of being auto-repaired. There is no public REST endpoint that writes an order transaction directly, so with `DRY_RUN=false` the script reports the exact `medusa exec` command to run inside your Medusa project. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest custom-provider-outstanding-desync/python
node --test custom-provider-outstanding-desync/node
```
