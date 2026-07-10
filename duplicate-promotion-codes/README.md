# Duplicate promotion codes

Medusa v2's Promotion module only enforces code uniqueness with a single
partial unique database index, `IDX_unique_promotion_code` on `code`, `WHERE
deleted_at IS NULL`. There is no application-level uniqueness check in
`createPromotionsWorkflow` before the insert, so the workflow just relies on
Postgres to reject a clash. Because that index is case-sensitive and only
scoped to non-deleted rows, promotions created through different paths, the
Admin UI, a seed or import script, multiple environments merged later, or a
request racing a soft-delete, can end up with codes that are byte-different
but functionally the same to a customer, for example `SAVE10` vs `save10`,
or `SAVE10` with a trailing space. Two live, active promotions can then both
match the same code a customer types in, and the storefront resolves to
whichever one the query happens to return.

This script pages through every promotion, normalizes each `code` with
`code.trim().toUpperCase()`, and groups them with a pure function,
`find_duplicate_promotion_codes` (Python) / `findDuplicatePromotionCodes`
(Node). Any group with more than one `promo_` id is a duplicate, including
the case and whitespace variants the database index does not catch. For each
group it also fetches the linked campaigns for context. It never merges or
deletes a promotion automatically, since two promotions sharing a code can
carry different discount rules or usage counters, and picking a winner is a
business call. The only write it can make, and only outside dry run, is
deactivating one named promotion by setting `status` to `inactive`, never
`DELETE`, since delete only soft-deletes and leaves the code eligible for
silent reuse later.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/duplicate-promotion-codes/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python duplicate-promotion-codes/python/find_duplicate_promotion_codes.py
node   duplicate-promotion-codes/node/find-duplicate-promotion-codes.js
```

Once a human has reviewed a duplicate group and picked the loser, set
`DEACTIVATE_PROMOTION_ID` to that `promo_` id and rerun with `DRY_RUN=false`
to deactivate it. Leaving `DEACTIVATE_PROMOTION_ID` unset just reports every
duplicate group and changes nothing.

## Test

```bash
pytest duplicate-promotion-codes/python
node --test duplicate-promotion-codes/node
```
