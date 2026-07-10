# Duplicate product handles from import

Medusa v2 auto-generates a product handle from its title whenever a create
payload omits one, but that default is applied per row inside the create or
batch product workflow. It never checks the rest of the store for a
collision, and the `handle` column has no enforced unique database
constraint, unlike `sku` or `ean` on variants. A CSV import with duplicate or
blank titles across rows, or one that gets re-run after a partial failure,
can therefore leave several products sharing one handle, which silently
breaks `/store/products/{handle}` routing for whichever product the
storefront picks first. This script lists every product, groups them by
handle with a pure decision function, and reports every duplicate group with
product ids, titles, status, and variant SKUs. It never deletes a product,
and it only renames a duplicate's handle when you explicitly opt in and turn
dry run off.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/duplicate-product-handles-from-import/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export AUTO_REPAIR="false"  # set true to allow renaming newer duplicates
export DRY_RUN="true"

python duplicate-product-handles-from-import/python/find_duplicate_handles.py
node   duplicate-product-handles-from-import/node/find-duplicate-handles.js
```

`find_duplicate_handles` / `findDuplicateHandles` is a pure function: it
groups the product list by handle, keeps only groups with more than one
member, and sorts each group's members by `created_at` ascending so the
oldest entry is the likely original. This is a diagnostic pass by default,
report only, no writes. If you set `AUTO_REPAIR=true`, the only write it will
make is `POST /admin/products/{id}` with a disambiguated `handle` such as
`original-handle-2` for every duplicate after the oldest in each group, and
that write is still gated behind `DRY_RUN`, so it only logs the intended call
until you set `DRY_RUN=false`. It never calls delete, since a duplicate may
hold real inventory or orders.

## Test

```bash
pytest duplicate-product-handles-from-import/python
node --test duplicate-product-handles-from-import/node
```
