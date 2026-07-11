# Cannot cancel a fulfillment once stock has gone negative

Canceling a fulfillment in Medusa v2 runs `cancelFulfillmentWorkflow`, which restores stock on the inventory location level tied to that fulfillment's line items. If that level's available stock (`stocked_quantity` minus `reserved_quantity`) is already negative, from an earlier oversell, a direct external write, or a drifted reservation, the restore step can fail or leave the level worse off, so the fulfillment gets stuck: neither canceled nor usable. This job lists active fulfillments, checks each one's inventory location level, and reports every fulfillment blocked by a negative level so a human can reconcile the stock first and retry the cancel.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/cancel-fulfillment-negative-stock/

## Run it

```bash
export MEDUSA_BACKEND_URL="https://your-medusa-backend.example.com"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python cancel-fulfillment-negative-stock/python/find_blocked_cancels.py
node   cancel-fulfillment-negative-stock/node/find-blocked-cancels.js
```

`is_cancel_blocked_by_negative_stock` is a pure function: a fulfillment is flagged only when it is not already canceled and its inventory location level already has negative available stock. The script only reads data and reports; it never writes a location level and never calls the cancel route itself. Reconciling the level and retrying the cancel are separate, deliberate steps a human takes after reviewing the report.

## Test

```bash
pytest cancel-fulfillment-negative-stock/python
node --test cancel-fulfillment-negative-stock/node
```
