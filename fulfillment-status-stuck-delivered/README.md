# Fulfillment status stuck on Delivered after a full return and refund

An order comes back in full, the warehouse receives the return, and the customer gets a full refund. But `fulfillment_status` on the Medusa v2 order still reads `delivered`, because neither `receiveReturnWorkflow` nor the refund workflow ever recomputes that field. This job lists orders with their items, fulfillments, and returns expanded, flags only the orders where every fulfilled unit has a matching received unit on a completed return and the refund already covers it, and tags those orders for review so reporting stops treating them as a clean, completed sale.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/fulfillment-status-stuck-delivered/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export REVIEW_TAG="returned-and-refunded"
export DRY_RUN="true"

pip install requests
python fulfillment-status-stuck-delivered/python/flag_stuck_fulfillment.py

npm install @medusajs/js-sdk
node fulfillment-status-stuck-delivered/node/flag-stuck-fulfillment.js
```

`decide_fulfillment_repair` (Python) and `decideFulfillmentRepair` (Node) are pure functions with no I/O: an order is flagged `stuck_delivered` only when every fulfilled unit has a matching received unit across its completed returns, the refunded total on the order summary covers the returned value, and `fulfillment_status` still reads `delivered` or `partially_delivered`. Anything still mid-return is classified `in_progress` and left untouched. The script never writes `fulfillment_status` directly, it only adds a metadata tag so your own reporting and support tools can trust it. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest fulfillment-status-stuck-delivered/python
node --test fulfillment-status-stuck-delivered/node
```
