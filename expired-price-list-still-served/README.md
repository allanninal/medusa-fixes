# Price list keeps serving prices past its end date

A Medusa price list can show "Expired" in the admin while the storefront's `calculated_price` still resolves to a price from that same list. Medusa enforces expiry only at read time inside the `calculatePrices` pipeline, and there is no background job that flips an expired list to `draft` for you. Product list endpoints, cached storefront region/product queries, and the admin's own status label can each evaluate the `starts_at`/`ends_at` window inconsistently, so an expired list can keep getting picked. This script flags every price list that is still `status: "active"` with an `ends_at` in the past, confirms the mismatch against the live Store API, and only moves a confirmed list to `draft` when you explicitly turn off `DRY_RUN`.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/expired-price-list-still-served/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export MEDUSA_PUBLISHABLE_KEY="pk_..."
export DRY_RUN="true"

python expired-price-list-still-served/python/flag_expired_price_lists.py
node   expired-price-list-still-served/node/flag-expired-price-lists.js
```

`is_price_list_expired_but_active` and `pick_best_calculated_price` are pure functions (the current time is passed in). The first returns true only when a price list's `status` is `"active"` and its `ends_at` is a real timestamp already in the past; it returns false when `ends_at` is null or the list is already `draft`. The second filters a set of candidate prices using that same expiry logic (plus a check for `price_list_status === "draft"`) before picking the lowest remaining amount, which mirrors the exact selection-plus-expiry-guard logic Medusa's own price selection should apply.

The script only reports by default. When `DRY_RUN=false`, it calls `POST /admin/price-lists/{id}` with `{"status": "draft"}` for each confirmed list, the smallest possible correction, since `status` is a hard filter Medusa respects everywhere, unlike the date window alone. After a real run, re-check `calculated_price` on the affected products and purge any CDN or HTTP cache in front of your `/store` routes, since this API call alone does not invalidate an external cache.

## Test

```bash
pytest expired-price-list-still-served/python
node --test expired-price-list-still-served/node
```
