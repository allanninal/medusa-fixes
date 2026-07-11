# Custom link no cascade delete

A custom module linked to product with `defineLink` does not cascade delete unless
`deleteCascade: true` is set, and even then the cascade only fires when the deletion
runs through Medusa's own Link/Remote Link APIs or workflow steps (`deleteProductsWorkflow`,
`removeRemoteLinkStep`, `link.delete`). A raw module-service delete or a direct SQL delete
on the product bypasses that cascade entirely, leaving rows in the custom link (pivot)
table pointing at a `prod_` id that no longer exists.

This script lists every live product id, lists every `product_id` your custom link table
currently stores, diffs the two sets with a pure function, and cross-checks each candidate
with a 404 lookup before reporting it. It only reports by default.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/custom-link-no-cascade-delete/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python custom-link-no-cascade-delete/python/find_dangling_links.py
node   custom-link-no-cascade-delete/node/find-dangling-links.js
```

`find_dangling_links` is a pure function: a link row is dangling only when its `product_id`
is not a member of the current live-product id set. The only write this repair path ever
makes is through your own custom module's declared `delete`/`softDelete` service method, run
from inside a `medusa exec` script, never a raw SQL delete. Start with `DRY_RUN=true` to
review the list first.

## Test

```bash
pytest custom-link-no-cascade-delete/python
node --test custom-link-no-cascade-delete/node
```
