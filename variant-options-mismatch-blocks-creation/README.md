# Variant options mismatch blocks creation

A Medusa product will not save a new variant, or an existing variant becomes uneditable, because that variant's `options` map does not exactly match the product's `options` array. Every product option title (Color, Size, and so on) must have exactly one value on every variant, drawn from that option's own `values` list. A missing title, an extra or unknown title, or a value that is no longer in the allowed list gets rejected by the product module before it is ever persisted, often surfacing as `Product options length does not match variant options length` or a duplicate/"already exists" conflict. This script scans your catalog and reports the exact product, variant, and mismatched titles or values so a merchant can supply the one thing Medusa cannot infer: the correct value.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/variant-options-mismatch-blocks-creation/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"

python variant-options-mismatch-blocks-creation/python/find_variant_options_mismatch.py
node   variant-options-mismatch-blocks-creation/node/find-variant-options-mismatch.js
```

`find_incomplete_variants` is a pure function: it computes the required option title set from `product.options[].title`, normalizes each variant's options (handling both the expanded admin shape of `{option: {title}, value}` entries and an already-flat `{title: value}` map) into a single `title -> value` object, then reports any variant with a missing title, an extra title, or a value not present in that option's real `values` list. It performs no I/O and never mutates anything, so it is directly unit-testable with plain fixture objects. The script itself only reports. It never calls `POST /admin/products/:id/variants/:variant_id` to guess a variant's missing value, because that value is business data only a merchant knows. `DRY_RUN` gates the log wording between "would flag" and "flagging," since this script by design never writes to your store.

## Test

```bash
pytest variant-options-mismatch-blocks-creation/python
node --test variant-options-mismatch-blocks-creation/node
```
