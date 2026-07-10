# Linked data missing after a link migration

A Medusa v2 module link created with `defineLink()` under `src/links/` is
backed by its own pivot table, separate from each module's own migrations.
That table is only created or updated when `db:sync-links` runs, or as part
of `db:migrate`. A deploy that runs migrations but skips the link sync, or a
link file added after the last migrate, leaves the link defined in code but
the table absent or stale, so the expanded relation resolves empty for every
record even though the linked module independently has rows. This script
lists parent records with the relation expanded, independently confirms the
linked module has data of its own, and classifies the result with a pure
function. It never writes, because there is no admin route that can create a
pivot table.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/linked-data-missing-after-link-migration/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export LINK_DEFINITION_EXISTS_IN_CODE="true"
export DRY_RUN="true"

python linked-data-missing-after-link-migration/python/detect_unmigrated_link.py
node   linked-data-missing-after-link-migration/node/detect-unmigrated-link.js
```

`detect_unmigrated_link` / `detectUnmigratedLink` is a pure function: it takes
the total number of parent records checked, how many of them resolved the
linked relation, whether the linked module has any records of its own, and
whether the link is defined in code, and returns one of `OK`,
`NO_LINK_DEFINED`, `LIKELY_UNMIGRATED_LINK`, or `LINK_NOT_YET_POPULATED`.
`LIKELY_UNMIGRATED_LINK` means every parent record resolved the relation as
empty even though the linked module independently has rows, the classic
symptom of a pivot table that was never synced. This script only reads. When
it reports `LIKELY_UNMIGRATED_LINK`, run `npx medusa db:sync-links` or
`npx medusa db:migrate` against the deployed backend, then run this check
again to confirm.

## Test

```bash
pytest linked-data-missing-after-link-migration/python
node --test linked-data-missing-after-link-migration/node
```
