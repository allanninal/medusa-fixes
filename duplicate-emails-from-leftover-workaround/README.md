# A leftover workaround subscriber duplicates order confirmation emails

A customer gets two order confirmation emails for the same order. The usual cause is a leftover `src/subscribers` workaround that once manually called `capturePaymentWorkflow` on `order.placed` to patch upstream payment-status bugs (Medusa issues #11766 and #13301), and kept running unconditionally after Medusa v2.11.1 fixed those bugs. This script lists recent orders, lists the notifications Medusa actually recorded for each one, and flags any order where a cluster of confirmation notifications to the same recipient landed within a short time window, the signature of `order.placed` firing more than once. It only ever reports, it never resends or deletes a notification, because Notification records are an audit trail.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/duplicate-emails-from-leftover-workaround/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DUPLICATE_WINDOW_MS="60000"
export DRY_RUN="true"

python duplicate-emails-from-leftover-workaround/python/find_duplicate_confirmations.py
node   duplicate-emails-from-leftover-workaround/node/find-duplicate-confirmations.js
```

`find_duplicate_notifications` is a pure function: it groups already-fetched order notifications by `resource_id`, sorts by `created_at`, and clusters consecutive sends to the same recipient within `windowMs` of each other. Any cluster larger than one is reported as a duplicate-send incident with the order id and the notification ids involved.

This script only writes to your logs. It never resends a notification and never deletes one. The actual repair, removing or version-gating the leftover `src/subscribers` file that still calls `capturePaymentWorkflow` on `order.placed`, is a separate code-level change that should go through your normal code review, not an automated data mutation.

## Test

```bash
pytest duplicate-emails-from-leftover-workaround/python
node --test duplicate-emails-from-leftover-workaround/node
```
