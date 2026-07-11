# Sub-cent rounding mislabels a paid order as partially captured

Medusa v2 derives an order's `payment_status` inside `getLastPaymentStatus` in the Payment module, by comparing the payment collection's `amount` against the summed `captured_amount` using a fixed tolerance, `MEDUSA_EPSILON`, that defaults to `0.0001`. Most payment providers settle to 2 decimal places, but internal BigNumber math on line items, taxes, and promotions can produce a collection amount with 3 or more decimal digits, like `9.9946` against a captured `9.99`. That `0.0046` remainder is bigger than the epsilon, so the order is flagged `partially_captured` even though it was paid in full to the cent. This script lists orders with their payment collections, classifies the delta between `amount` and `captured_amount` with a pure function, and clears only the deltas smaller than one currency minor unit by capturing the exact remainder, never by writing status directly.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/rounding-partial-capture-mislabel/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python rounding-partial-capture-mislabel/python/clear_rounding_mislabel.py
node   rounding-partial-capture-mislabel/node/clear-rounding-mislabel.js
```

`classify_capture_delta` (Python) / `classifyCaptureDelta` (Node) is a pure function: it computes `delta = amount - captured_amount`, scales a currency minor unit from the currency's decimal digits so zero decimal currencies like JPY behave correctly, and returns an action of `clear` when `0 < delta < minorUnit`, `flag` when the delta is at or above one minor unit, or `none` when there is nothing outstanding. No network or database calls.

The repair step never writes `payment_collection.status` directly, since it is computed by `getLastPaymentStatus` on every read and would just get overwritten. It captures the exact delta through the Admin API's payment capture route (`POST /admin/payments/{id}/capture` with `{"amount": delta}`), which makes `captured_amount` equal `amount` and lets Medusa's own status computation resolve to `captured` on its own. Deltas classified `flag` are left alone and reported, since they represent a real outstanding balance, not rounding noise. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest rounding-partial-capture-mislabel/python
node --test rounding-partial-capture-mislabel/node
```
