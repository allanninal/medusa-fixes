# Fulfillment without a tracking number

In Medusa v2, a fulfillment's tracking data lives in `Fulfillment.labels[]`,
each label carrying `tracking_number`, `tracking_url`, and `label_url`,
separate from the `shipped_at` timestamp that actually marks it as shipped.
The Admin dashboard's Create Shipment flow, backed by `createShipmentWorkflow`,
has historically built the shipment's labels solely from whatever was typed
into that form's tracking number input, discarding any labels a fulfillment
provider had already attached in `createFulfillment()`. Because tracking
number entry is optional, a merchant can click Mark as Shipped, setting
`shipped_at`, while `labels` stays empty.

There is no legitimate value a script can invent for a missing tracking
number, so this only flags and reports. The only write it will ever make is
attaching a real label a human has already obtained from the carrier or
fulfillment provider, and only when `DRY_RUN` is off.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/fulfillment-without-a-tracking-number/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python fulfillment-without-a-tracking-number/python/flag_untracked_shipments.py
node   fulfillment-without-a-tracking-number/node/flag-untracked-shipments.js
```

`find_untracked_shipments` (Python) / `findUntrackedShipments` (Node) is a
pure decision function: given a list of fulfillments, it flags any
fulfillment where `shipped_at` is set, `canceled_at` is not set, and either
`labels` is missing or empty, or every label on it has a blank
`tracking_number`. The script pages through orders with
`*fulfillments,*fulfillments.labels` explicitly expanded, since list
responses can omit nested `labels` unless you ask for them, then re-reads
each suspect fulfillment directly via
`GET /admin/orders/{order_id}/fulfillments/{fulfillment_id}` before flagging
it, so the report never wrongly accuses a fulfillment that actually has a
label. The output is a report of `{order_id, display_id, fulfillment_id,
shipped_at, provider_id}` for support to chase down with the carrier. The
only corrective write, attaching a real tracking number via
`POST /admin/orders/{order_id}/fulfillments/{fulfillment_id}/shipment`, only
happens when `DRY_RUN=false` and a human has supplied the real value, never a
synthesized one. Start with `DRY_RUN=true` to review the full list first.

## Test

```bash
pytest fulfillment-without-a-tracking-number/python
node --test fulfillment-without-a-tracking-number/node
```
