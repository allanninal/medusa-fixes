# Duplicate product scrambles variant option pairings

Medusa links a `ProductVariant` to its options by title to value pairing, for
example `options: {"Size": "Small", "Color": "Red"}`, not by a stable
positional index. When a product is duplicated, its `ProductOption` and
`ProductOptionValue` rows are recreated on the copy with brand new ids, and
the duplication step re-attaches each new variant to that new set. If that
re-attachment happens by creation order instead of by matching each source
variant's actual title and value pairing, a variant in the duplicate can land
on the wrong value even though the variant count and SKUs still look correct.
This script fetches the source product and the duplicate product, normalizes
every variant's options into a canonical signature string with a pure
decision function, and reports every duplicate variant whose signature does
not match its source counterpart. It never writes to the option or option
value tables directly, and it only corrects a mismatched variant's options
through the existing variant update route when you explicitly turn dry run
off.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/duplicate-product-scrambles-variants/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export SOURCE_PRODUCT_ID="prod_source"
export DUPLICATE_PRODUCT_ID="prod_duplicate"
export DRY_RUN="true"

python duplicate-product-scrambles-variants/python/diff_variant_options.py
node   duplicate-product-scrambles-variants/node/diff-variant-options.js
```

`diff_variant_option_signatures` / `diffVariantOptionSignatures` is a pure
function: it normalizes each variant's options into a sorted `title:value`
signature string, matches source variants to duplicate variants by SKU (or by
index when SKUs are missing or collide), and returns an entry only when the
two signatures differ, carrying both the expected and actual signature. This
is a diagnostic pass by default, report only, no writes. If you set
`DRY_RUN=false`, the only write it will make is `POST
/admin/products/{product_id}/variants/{variant_id}` with a title to value
`options` map for each mismatched variant, driven by the expected signature
computed from the source product. It never rewrites the option or option
value tables directly, since those are owned by the product module's own
linking logic.

## Test

```bash
pytest duplicate-product-scrambles-variants/python
node --test duplicate-product-scrambles-variants/node
```
