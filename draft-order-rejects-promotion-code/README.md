# Draft order rejects a valid promotion code

A Medusa v2 draft order rejects a promotion code that works fine on a storefront cart, throwing "An active Order Change is required to proceed." Draft order promotions go through `addDraftOrderPromotionWorkflow`, which requires an active `order_change` (opened with `POST /admin/draft-orders/:id/edit`) before it will even look at the code. This script reads the draft order's `order_change` and the promotion's own `status`, classifies the exact rejection reason, and only repairs the safe case: a missing or inactive edit session. A promotion that is genuinely not active is flagged for a human to activate in Medusa Admin, never forced.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/draft-order-rejects-promotion-code/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRAFT_ORDER_ID="draftord_01..."
export PROMO_CODES="SAVE10,OFF20"
export DRY_RUN="true"

python draft-order-rejects-promotion-code/python/fix_draft_order_promo_code.py
node   draft-order-rejects-promotion-code/node/fix-draft-order-promo-code.js
```

`classify_promo_rejection` (`classifyPromoRejection` in Node) is a pure function: given the draft order's status, `is_draft_order` flag, and `order_change`, plus the known promotions and the requested codes, it returns one of `not_draft_order`, `no_active_edit_session`, `edit_session_inactive`, `code_not_found`, `code_not_active`, or `ok` per code. Only `no_active_edit_session` and `edit_session_inactive` are repaired automatically, by opening `POST /admin/draft-orders/:id/edit`, adding the codes, then requesting and confirming the change. `code_not_active` is never auto-fixed, it is logged for a human to activate the promotion in Medusa Admin. Start with `DRY_RUN=true` to review the plan first.

## Test

```bash
pip install pytest && pytest draft-order-rejects-promotion-code/python
node --test draft-order-rejects-promotion-code/node
```
