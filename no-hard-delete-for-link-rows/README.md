# No API to hard delete link table rows after entity removal

Medusa v2's Module Links deliberately expose only soft-delete style operations. `link.dismiss` (and the `dismissRemoteLinkStep` workflow step) marks a link table row with `deleted_at` rather than removing it, and `link.delete` only cascades when the link definition is configured to. Medusa's core team confirmed on GitHub (medusajs/medusa#13315) this is by design, not a bug, because a workflow step must be reversible through compensation, and an irreversible hard delete of a pivot row cannot be undone. When a linked entity, such as a product, sales channel, or variant, is removed outside a workflow, the matching link row is left behind, either live and pointing at a gone id, or already soft-deleted, and no public API will ever purge either one.

This script reads the live ids on both sides of a known link pair over the Admin API, reads the raw link rows a companion `medusa exec` script exposed (since `getLinkModule` only resolves inside a Medusa server context), classifies every row with a pure function, and reports every row that is not already fine.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/no-hard-delete-for-link-rows/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python no-hard-delete-for-link-rows/python/classify_link_rows.py
node   no-hard-delete-for-link-rows/node/classify-link-rows.js
```

`classify_link_row` is a pure function: a row is `orphan_soft_deleted` when `deleted_at` is set (always reportable, since no API ever purges it), `orphan_dangling` when a live-looking row points at a parent id that no longer exists, or `ok` otherwise. The script only reports by default. Hard-deleting a confirmed orphan uses the undocumented `link.getLinkModule` escape hatch and must run from inside Medusa, so that step is documented in the guide, not executed by this external script. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest no-hard-delete-for-link-rows/python
node --test no-hard-delete-for-link-rows/node
```
