# Backfill external id for reconciliation

Medusa v2's Order module has no first-class `external_id` column. The
official ERP integration recipe stores the external or legacy identifier
under `metadata.external_id`, a generic JSONB field, instead of a structured
one. Orders created before an integration existed, imported by a seed
script, or created through a flow that dropped metadata along the way (a
pattern GitHub issues [#7398](https://github.com/medusajs/medusa/issues/7398)
and [#5764](https://github.com/medusajs/medusa/issues/5764) both show is easy
to trigger), end up with `metadata` null or missing that key. There is no
unique constraint or migration path tying Medusa's internal `order_id` to a
legacy identifier, so once the mapping is lost it can only be recovered by
matching against an external export, not by any built-in Medusa mechanism.

This script lists orders missing `metadata.external_id`, matches each one
against a legacy CSV export using a pure decision function,
`decide_external_id_backfill` (Python) / `decideExternalIdBackfill` (Node),
and only applies the id when exactly one legacy row matches. Orders with
zero or multiple matches are flagged for manual reconciliation, never
guessed, since a wrong `external_id` would silently corrupt cross-system
matching. Every write resends the full existing `metadata` object plus the
new key, since Medusa v2 replaces nested metadata on update instead of
merging it.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/backfill-external-id-for-reconciliation/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export LEGACY_EXPORT_PATH="legacy_orders.csv"
export DRY_RUN="true"

python backfill-external-id-for-reconciliation/python/backfill_external_id.py
node   backfill-external-id-for-reconciliation/node/backfill-external-id.js
```

The legacy export is a CSV with columns `legacy_id, display_id, email,
total, created_at`. `display_id`, `total`, and `created_at` may be blank for
a given row.

`decide_external_id_backfill` (Python) / `decideExternalIdBackfill` (Node) is
a pure decision function: given an order and the full list of legacy
candidates, it (1) returns `skip_has_id` if `metadata.external_id` is
already a non-empty string, (2) filters candidates to those matching on
`display_id` when the order has one, or on `email` plus `total` within a
small epsilon plus `created_at` within a one day window otherwise, (3)
returns `apply` with the matched `external_id` only when exactly one
candidate matches, (4) returns `flag_no_match` when zero candidates match,
and (5) returns `flag_ambiguous` when more than one candidate matches,
never guessing between them. The runner only calls the update endpoint for
`apply`; `flag_ambiguous` and `flag_no_match` are printed to a CSV report for
a human to resolve. Start with `DRY_RUN=true` to review the full report
before writing anything.

## Test

```bash
pytest backfill-external-id-for-reconciliation/python
node --test backfill-external-id-for-reconciliation/node
```
