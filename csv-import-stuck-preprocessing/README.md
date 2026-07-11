# Product import stuck at preprocessing

Medusa v2's `importProductsWorkflow`, which powers `POST /admin/products/import`, deliberately pauses at `waitConfirmationProductImportStep` after `normalizeCsvStep` finishes. That pause is the preprocessing state you see, and the transaction sits idle until something calls `POST /admin/products/import/:transaction_id/confirm`. If that confirm call is dropped, the admin UI never shows the review prompt, or the workflow engine's event bus is misconfigured, the transaction never resumes and no `product.created` or `product.updated` event ever fires.

This job tracks each import transaction you start in a local JSON file, polls the workflow engine's state for each one, and flags any transaction still `invoking` or `waiting` past a timeout with no completion event observed. It never calls confirm on your behalf.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/csv-import-stuck-preprocessing/

## Run it

```bash
export MEDUSA_BACKEND_URL="https://your-medusa-backend.com"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export IMPORT_TIMEOUT_MINUTES="15"
export DRY_RUN="true"

python csv-import-stuck-preprocessing/python/flag_stuck_import.py
node   csv-import-stuck-preprocessing/node/flag-stuck-import.js
```

`classify_import_job` is a pure function (the current time is passed in): a transaction is flagged `stuck` only when its workflow state is still `invoking` or `waiting`, it is past `IMPORT_TIMEOUT_MINUTES`, and no completion event has been observed. A `done` state returns `completed`, and `failed` or `reverted` returns `failed`. The only write, when `DRY_RUN=false`, is marking the transaction `flagged_stale` in your own tracking file. It never calls the confirm route programmatically. Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest csv-import-stuck-preprocessing/python
node --test csv-import-stuck-preprocessing/node
```
