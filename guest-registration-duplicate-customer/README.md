# Guest checkout creates a duplicate customer on registration

Medusa v2 stores guest and registered customers as separate `Customer` rows
keyed by email, without deduplicating across account states. A guest checkout
creates a row with `has_account: false`. When that same email later registers
through `POST /auth/customer/emailpass/register`, the
`validateCustomerAccountCreation` step inside `createCustomerAccountWorkflow`
only rejects the registration if a row for that email already has
`has_account: true`. It never looks up and reuses the existing guest row, so
the workflow creates a brand new `Customer` row with `has_account: true` and a
fresh `AuthIdentity`. The guest's prior orders stay foreign-keyed to the now
orphaned guest `cus_` id, invisible to the newly registered account.

This script is read-only. It pages through every customer, groups the rows by
normalized email, flags the exact guest-plus-registered pattern with a pure
function, `find_duplicate_customer_groups` (Python) /
`findDuplicateCustomerGroups` (Node), and for each flagged pair counts the
orders still stuck on the orphaned guest id. Nothing is merged or written.
Merging a confirmed pair is a deliberate, manual action, since Medusa v2 has no
documented admin route for reassigning an order's customer.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/guest-registration-duplicate-customer/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python guest-registration-duplicate-customer/python/detect_duplicate_customers.py
node   guest-registration-duplicate-customer/node/detect-duplicate-customers.js
```

`find_duplicate_customer_groups` (Python) / `findDuplicateCustomerGroups`
(Node) is a pure decision function: given a plain array of customer rows, it
groups them by normalized (trimmed, lowercased) email, then flags a group as
a duplicate only when it has exactly one `has_account: false` row alongside at
least one `has_account: true` row sharing that email. A single guest row, a
single registered row, or two registered rows sharing an email are all left
unflagged by this pattern. The runner logs a report of
`{email, guest_customer_id, registered_customer_id, orphaned_order_count}`
for every flagged pair. `DRY_RUN` stays on by default; this script never calls
a write endpoint regardless of the flag, since the safe repair for existing
duplicates is a manual, human-confirmed merge, not an automated one.

## Test

```bash
pytest guest-registration-duplicate-customer/python
node --test guest-registration-duplicate-customer/node
```
