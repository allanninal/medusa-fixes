# Orders stuck on the guest customer record

A shopper checks out as a guest, then registers later with the same email, expecting to see their order in the new account. Medusa v2 keys a `Customer` row by `(email, has_account)`, not by email alone, so registration creates a separate `Customer` row instead of promoting the guest one. The order's `customer_id` is never updated, so it stays linked to the old guest record and is invisible to the new authenticated account.

Medusa deliberately does not auto-merge these on registration, since blindly re-linking by email would let anyone claim another person's guest orders just by signing up with that email. This script only reads by default: it pages through every customer, flags the orphaned guest-plus-registered pattern, lists the stuck orders per pair, and prints the planned transfer requests as `order_id -> target customer_id`. Nothing is sent to Medusa unless `DRY_RUN` is false and a human has approved the batch, and each transfer still requires the original guest order owner to accept it by email through Medusa's own Order Transfer workflow.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/orders-stuck-on-guest-customer/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python orders-stuck-on-guest-customer/python/reconcile_guest_orders.py
node   orders-stuck-on-guest-customer/node/reconcile-guest-orders.js
```

`find_orphaned_guest_orders` is a pure function: it groups customers by lowercased email, keeps only the groups with exactly one `has_account: false` row and one `has_account: true` row, and attaches the order ids still pointing at the guest id. Start with `DRY_RUN=true` to review the planned transfers first. Only set `DRY_RUN=false` after a human has approved the specific batch, and remember that Medusa still requires the original order owner to accept each transfer by email before anything moves.

## Test

```bash
pytest orders-stuck-on-guest-customer/python
node --test orders-stuck-on-guest-customer/node
```
