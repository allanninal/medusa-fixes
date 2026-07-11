# Duplicate product barcode conflict

The admin Duplicate action clones a product by re-submitting its variants
through `createProductsWorkflow` and `createProductVariantsWorkflow`, the
same workflows used for a normal `POST /admin/products`, and it copies every
variant field verbatim, including `sku`, `ean`, `upc`, and `barcode`. The
`product_variant` table has unique partial indexes on those identifier
columns, scoped to `deleted_at IS NULL`, so a duplicated variant that carries
the same barcode as its source hits a Postgres unique constraint violation
(tracked in [medusajs/medusa#5541](https://github.com/medusajs/medusa/issues/5541)).
Medusa never auto-clears or regenerates these fields, so the failure is
deterministic, not a race condition, for any product whose variants have a
barcode-family value set. This script lists every product's variants,
groups their identifier fields with a pure decision function, and reports
every barcode, ean, or upc shared by more than one product. It never
overwrites a barcode automatically, and it only clears one confirmed field
on one confirmed variant id when you explicitly opt in and turn dry run off.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/duplicate-product-barcode-conflict/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export CONFIRMED_VARIANT_ID=""   # set to a reported variant_id to clear it
export CONFIRMED_FIELD=""        # "barcode", "ean", or "upc"
export DRY_RUN="true"

python duplicate-product-barcode-conflict/python/find_barcode_conflicts.py
node   duplicate-product-barcode-conflict/node/find-barcode-conflicts.js
```

`find_barcode_conflicts` / `findBarcodeConflicts` is a pure function: it
groups the variant list by each non-null, non-empty value of `barcode`,
`ean`, and `upc` independently, and keeps only the groups whose entries span
more than one distinct product id. Same-product multi-variant repeats, such
as a color-only variant reusing the parent barcode, are never flagged. This
is a diagnostic pass by default, report only, no writes. If you set
`CONFIRMED_VARIANT_ID` and `CONFIRMED_FIELD` to a variant id and field
already present in the report, the only write it will make is
`POST /admin/products/{product_id}/variants/{variant_id}` with that one
field set to `null`, and that write is still gated behind `DRY_RUN`, so it
only logs the intended call until you set `DRY_RUN=false`. It never invents
a replacement barcode.

## Test

```bash
pytest duplicate-product-barcode-conflict/python
node --test duplicate-product-barcode-conflict/node
```
