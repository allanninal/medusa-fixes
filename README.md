# Medusa Fixes

Small, tested Python and Node.js scripts that detect and repair real problems on **Medusa** stores. Hidden products, missing region prices, stuck inventory reservations, carts that will not complete, orders that never fulfill, promotions that will not apply, broken module links, and missed background jobs.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/medusa](https://www.allanninal.dev/medusa/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
[![Tests](https://github.com/allanninal/medusa-fixes/actions/workflows/tests.yml/badge.svg)](https://github.com/allanninal/medusa-fixes/actions/workflows/tests.yml)

## How the scripts work

The scripts talk to the **Medusa (v2) Admin API**. They exchange an email and password for a JWT at `POST /auth/user/emailpass`, then call `/admin/*` routes with a Bearer token. Node uses the built-in `fetch`; Python uses `requests`. Money is decimal, not cents. The decision logic in every fix is a pure function with no I/O, so it is unit tested.

## Setup

Set the environment variables a fix needs. Use an admin user's email and password, or an admin API token.

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"   # start safe
```

Python needs `pip install requests pytest`. Node needs Node 18 or newer (the scripts use the built-in `fetch`, no packages).

## The fixes

| Fix | What it does | Type | Guide |
|---|---|---|---|
| [storefront-shows-no-products-missing-publishable-key](./storefront-shows-no-products-missing-publishable-key/) | A Store API request with no publishable API key returns an empty list. Detect the missing key and wire it to a sales channel. | Diagnostic | [Read](https://www.allanninal.dev/medusa/storefront-shows-no-products-missing-publishable-key/) |
| [publishable-key-not-linked-to-a-sales-channel](./publishable-key-not-linked-to-a-sales-channel/) | The key exists but points at no sales channel, so products stay hidden. Link it. | Diagnostic | [Read](https://www.allanninal.dev/medusa/publishable-key-not-linked-to-a-sales-channel/) |
| [store-requests-blocked-by-cors](./store-requests-blocked-by-cors/) | The storefront gets CORS errors from the Store API. Probe the endpoints and report the gap. | Diagnostic | [Read](https://www.allanninal.dev/medusa/store-requests-blocked-by-cors/) |
| [product-has-no-price-in-a-region](./product-has-no-price-in-a-region/) | A variant has no price in the region currency, so it cannot be bought there. Find the gaps. | Reconciler | [Read](https://www.allanninal.dev/medusa/product-has-no-price-in-a-region/) |
| [price-list-not-applied-at-checkout](./price-list-not-applied-at-checkout/) | A sale price list is set but the cart still shows list price. Check its status and dates. | Diagnostic | [Read](https://www.allanninal.dev/medusa/price-list-not-applied-at-checkout/) |
| [wrong-currency-shown-for-a-region](./wrong-currency-shown-for-a-region/) | The region currency and the shown price currency disagree. Flag the mismatched prices. | Diagnostic | [Read](https://www.allanninal.dev/medusa/wrong-currency-shown-for-a-region/) |
| [tax-inclusive-pricing-shows-wrong-totals](./tax-inclusive-pricing-shows-wrong-totals/) | Tax-inclusive and tax-exclusive prices are mixed, so totals look off. Detect the mismatch. | Diagnostic | [Read](https://www.allanninal.dev/medusa/tax-inclusive-pricing-shows-wrong-totals/) |
| [variant-not-purchasable-no-inventory-level](./variant-not-purchasable-no-inventory-level/) | A tracked variant has no inventory level at the location, so it reads out of stock. Create it. | Reconciler | [Read](https://www.allanninal.dev/medusa/variant-not-purchasable-no-inventory-level/) |
| [sales-channel-not-linked-to-a-stock-location](./sales-channel-not-linked-to-a-stock-location/) | The channel has no stock location, so nothing is in stock there. Link a location. | Diagnostic | [Read](https://www.allanninal.dev/medusa/sales-channel-not-linked-to-a-stock-location/) |
| [stuck-reservations-after-cancelled-carts](./stuck-reservations-after-cancelled-carts/) | Cancelled carts left reservations that still hold stock. Release the stale ones. | Reconciler | [Read](https://www.allanninal.dev/medusa/stuck-reservations-after-cancelled-carts/) |
| [oversold-variant-goes-negative](./oversold-variant-goes-negative/) | Stock dropped below zero after a race. Reset the oversold variants to a real count. | Repair | [Read](https://www.allanninal.dev/medusa/oversold-variant-goes-negative/) |
| [inventory-not-managed-never-sells-out](./inventory-not-managed-never-sells-out/) | manage_inventory is off, so a variant never runs out. Detect them and turn it on. | Diagnostic | [Read](https://www.allanninal.dev/medusa/inventory-not-managed-never-sells-out/) |
| [cart-completion-fails-no-payment-provider](./cart-completion-fails-no-payment-provider/) | The region has no payment provider, so checkout cannot finish. Find the empty regions. | Repair | [Read](https://www.allanninal.dev/medusa/cart-completion-fails-no-payment-provider/) |
| [no-shipping-option-for-the-cart](./no-shipping-option-for-the-cart/) | A service zone gap leaves the cart with no shipping option. Detect the uncovered regions. | Diagnostic | [Read](https://www.allanninal.dev/medusa/no-shipping-option-for-the-cart/) |
| [abandoned-carts-pile-up](./abandoned-carts-pile-up/) | Old carts that never completed clutter the database. Report the stale ones for cleanup. | Reconciler | [Read](https://www.allanninal.dev/medusa/abandoned-carts-pile-up/) |
| [stale-cart-prices-after-a-price-change](./stale-cart-prices-after-a-price-change/) | A price change did not reach open carts. Flag the carts still holding the old price. | Reconciler | [Read](https://www.allanninal.dev/medusa/stale-cart-prices-after-a-price-change/) |
| [order-stuck-not-fulfilled-past-sla](./order-stuck-not-fulfilled-past-sla/) | A paid order sat unfulfilled past your promise. Tag the overdue ones for review. | Diagnostic | [Read](https://www.allanninal.dev/medusa/order-stuck-not-fulfilled-past-sla/) |
| [payment-captured-but-order-not-paid](./payment-captured-but-order-not-paid/) | The capture went through but the order still reads unpaid. Reconcile the payment status. | Reconciler | [Read](https://www.allanninal.dev/medusa/payment-captured-but-order-not-paid/) |
| [fulfillment-without-a-tracking-number](./fulfillment-without-a-tracking-number/) | A fulfillment shipped with no tracking number. Flag the ones missing it. | Diagnostic | [Read](https://www.allanninal.dev/medusa/fulfillment-without-a-tracking-number/) |
| [refund-not-reflected-on-the-order](./refund-not-reflected-on-the-order/) | A refund in the provider never updated the order. Record it so totals tie out. | Reconciler | [Read](https://www.allanninal.dev/medusa/refund-not-reflected-on-the-order/) |
| [promotion-not-applying-rules-mismatch](./promotion-not-applying-rules-mismatch/) | A promotion never applies because its rules do not match the cart. Check the rules. | Diagnostic | [Read](https://www.allanninal.dev/medusa/promotion-not-applying-rules-mismatch/) |
| [campaign-budget-exceeded-still-applies](./campaign-budget-exceeded-still-applies/) | A campaign past its budget keeps discounting. Detect and stop it. | Diagnostic | [Read](https://www.allanninal.dev/medusa/campaign-budget-exceeded-still-applies/) |
| [duplicate-promotion-codes](./duplicate-promotion-codes/) | Two promotions share a code and collide. Report the duplicates. | Diagnostic | [Read](https://www.allanninal.dev/medusa/duplicate-promotion-codes/) |
| [linked-data-missing-after-link-migration](./linked-data-missing-after-link-migration/) | A module link was added but never migrated, so linked data is missing. Detect it. | Diagnostic | [Read](https://www.allanninal.dev/medusa/linked-data-missing-after-link-migration/) |
| [orphaned-records-after-a-link-delete](./orphaned-records-after-a-link-delete/) | Deleting a link left dangling records behind. Find and clean the orphans. | Reconciler | [Read](https://www.allanninal.dev/medusa/orphaned-records-after-a-link-delete/) |
| [variant-options-mismatch-blocks-creation](./variant-options-mismatch-blocks-creation/) | A variant is missing an option value, so creation fails. Detect the incomplete variants. | Diagnostic | [Read](https://www.allanninal.dev/medusa/variant-options-mismatch-blocks-creation/) |
| [duplicate-product-handles-from-import](./duplicate-product-handles-from-import/) | An import created products with the same handle. Report the conflicts. | Reconciler | [Read](https://www.allanninal.dev/medusa/duplicate-product-handles-from-import/) |
| [broken-product-image-links](./broken-product-image-links/) | Product images point at files that no longer load. Detect the broken ones. | Diagnostic | [Read](https://www.allanninal.dev/medusa/broken-product-image-links/) |
| [events-lost-without-redis-event-bus](./events-lost-without-redis-event-bus/) | In production the in-memory event bus drops events, so side effects are missed. Reconcile them. | Reconciler | [Read](https://www.allanninal.dev/medusa/events-lost-without-redis-event-bus/) |
| [workflow-left-half-done](./workflow-left-half-done/) | A workflow failed mid-run and compensation did not undo it. Find the half-done records. | Reconciler | [Read](https://www.allanninal.dev/medusa/workflow-left-half-done/) |
| [scheduled-job-did-not-run](./scheduled-job-did-not-run/) | A scheduled job silently skipped, so its work is missing. Detect the gap and catch up. | Reconciler | [Read](https://www.allanninal.dev/medusa/scheduled-job-did-not-run/) |
| [subscriber-fails-silently-on-order-placed](./subscriber-fails-silently-on-order-placed/) | An order.placed subscriber threw and was swallowed. Find orders missing the side effect. | Diagnostic | [Read](https://www.allanninal.dev/medusa/subscriber-fails-silently-on-order-placed/) |
| [backfill-external-id-for-reconciliation](./backfill-external-id-for-reconciliation/) | Old orders lack the external id needed to match your other systems. Backfill it safely. | Repair | [Read](https://www.allanninal.dev/medusa/backfill-external-id-for-reconciliation/) |
| [draft-orders-never-completed](./draft-orders-never-completed/) | Draft orders that were never completed pile up. Report the stale ones. | Reconciler | [Read](https://www.allanninal.dev/medusa/draft-orders-never-completed/) |
| [guest-registration-duplicate-customer](./guest-registration-duplicate-customer/) | Registering with a prior guest order email makes a second customer row instead of updating has_account; script finds email duplicates. | Diagnostic | [Read](https://www.allanninal.dev/medusa/guest-registration-duplicate-customer/) |
| [orders-stuck-on-guest-customer](./orders-stuck-on-guest-customer/) | Orders remain attached to the guest customer row instead of the new registered account sharing that email; script re-links by email. | Reconciler | [Read](https://www.allanninal.dev/medusa/orders-stuck-on-guest-customer/) |
| [admin-invite-email-collision](./admin-invite-email-collision/) | Inviting an admin user throws identity already exists if a store customer used that email; script cross checks identities before invite. | Diagnostic | [Read](https://www.allanninal.dev/medusa/admin-invite-email-collision/) |
| [orphaned-auth-identity-blocks-reinvite](./orphaned-auth-identity-blocks-reinvite/) | A failed accept invite workflow reverts the invite to pending but keeps the auth identity, blocking re-acceptance; script finds and clears it. | Reconciler | [Read](https://www.allanninal.dev/medusa/orphaned-auth-identity-blocks-reinvite/) |
| [stale-reservation-after-fulfillment](./stale-reservation-after-fulfillment/) | Fulfilling an order occasionally fails to delete its reservation row, locking stock; script finds and removes reservations tied to closed orders. | Reconciler | [Read](https://www.allanninal.dev/medusa/stale-reservation-after-fulfillment/) |
| [negative-reserved-quantity-bundles](./negative-reserved-quantity-bundles/) | Bundled product variants under-reserve then swing reserved_quantity negative on fulfillment; script flags negative reserved_quantity rows. | Diagnostic | [Read](https://www.allanninal.dev/medusa/negative-reserved-quantity-bundles/) |
| [reservation-blocks-own-order-fulfillment](./reservation-blocks-own-order-fulfillment/) | When reserved quantity equals stocked quantity, admin refuses to fulfill even the order that holds the reservation; script frees orphaned reservations. | Reconciler | [Read](https://www.allanninal.dev/medusa/reservation-blocks-own-order-fulfillment/) |
| [reservation-missing-order-id](./reservation-missing-order-id/) | The order id field on inventory reservations is always blank, so scripts must join through line items instead of a direct key. | Reconciler | [Read](https://www.allanninal.dev/medusa/reservation-missing-order-id/) |
| [reservation-updated-event-not-firing](./reservation-updated-event-not-firing/) | RESERVATION_ITEM_UPDATED does not trigger on manual or system changes, so stock-sync subscribers miss updates; script diffs quantity against last synced value. | Reconciler | [Read](https://www.allanninal.dev/medusa/reservation-updated-event-not-firing/) |
| [untracked-variant-quantity-drift](./untracked-variant-quantity-drift/) | Variants opted out of tracking still get stocked_quantity decremented; script diffs untracked variants against their level history for drift. | Reconciler | [Read](https://www.allanninal.dev/medusa/untracked-variant-quantity-drift/) |
| [backorder-reservation-step-fails](./backorder-reservation-step-fails/) | Cart completion throws at the reservation step for backorder enabled variants at zero or negative stock, leaving carts stuck; script detects and reruns. | Diagnostic | [Read](https://www.allanninal.dev/medusa/backorder-reservation-step-fails/) |
| [inventory-wrong-stock-location](./inventory-wrong-stock-location/) | A sale reduces stock at the product's first linked location rather than the one tied to the order's sales channel; script compares expected vs actual location. | Diagnostic | [Read](https://www.allanninal.dev/medusa/inventory-wrong-stock-location/) |
| [checkout-blocked-multi-location-cart](./checkout-blocked-multi-location-cart/) | A cart with items stocked at two locations under the same channel fails to complete though both are in stock; script finds carts stuck at reservation. | Diagnostic | [Read](https://www.allanninal.dev/medusa/checkout-blocked-multi-location-cart/) |
| [multi-channel-key-zero-stock](./multi-channel-key-zero-stock/) | Store API shows zero available stock instead of summing locations when a key maps to multiple sales channels; script compares admin vs store quantities. | Diagnostic | [Read](https://www.allanninal.dev/medusa/multi-channel-key-zero-stock/) |
| [custom-provider-capture-skips-transaction](./custom-provider-capture-skips-transaction/) | A provider returning captured status never creates the order transaction, so paid_total stays wrong; script recomputes paid_total from provider records. | Repair | [Read](https://www.allanninal.dev/medusa/custom-provider-capture-skips-transaction/) |
| [outstanding-amount-stale-after-refund](./outstanding-amount-stale-after-refund/) | Only the first refund updates outstanding_amount, letting later refunds repeat the same amount unnoticed; script diffs summary against real provider refunds. | Diagnostic | [Read](https://www.allanninal.dev/medusa/outstanding-amount-stale-after-refund/) |
| [custom-provider-outstanding-desync](./custom-provider-outstanding-desync/) | After a custom provider capture, outstanding_amount and paid_total drift from actual payments, corrupting later refunds; script recalculates and flags drift. | Diagnostic | [Read](https://www.allanninal.dev/medusa/custom-provider-outstanding-desync/) |
| [refund-blocked-zero-outstanding](./refund-blocked-zero-outstanding/) | The refund API blocks valid refunds citing no outstanding balance even though the payment was fully captured; script flags and issues the refund directly. | Repair | [Read](https://www.allanninal.dev/medusa/refund-blocked-zero-outstanding/) |
| [second-refund-fails](./second-refund-fails/) | Later refund attempts silently fail after the first, leaving refunded total below what admin recorded; script sums refund transactions against the order total. | Diagnostic | [Read](https://www.allanninal.dev/medusa/second-refund-fails/) |
| [rounding-partial-capture-mislabel](./rounding-partial-capture-mislabel/) | A rounding gap under one cent between collection and captured amount flags fully paid orders as partially_captured; script recomputes and clears near-zero deltas. | Repair | [Read](https://www.allanninal.dev/medusa/rounding-partial-capture-mislabel/) |
| [new-collection-ignores-prior-capture](./new-collection-ignores-prior-capture/) | After a price edit, a new payment collection shows the full new total instead of the remaining outstanding balance; script recomputes outstanding and reconciles. | Reconciler | [Read](https://www.allanninal.dev/medusa/new-collection-ignores-prior-capture/) |
| [stripe-captured-no-order-created](./stripe-captured-no-order-created/) | Funds are captured in Stripe but the cart never completes to an order due to a webhook race; script reconciles Stripe charges against Medusa orders. | Reconciler | [Read](https://www.allanninal.dev/medusa/stripe-captured-no-order-created/) |
| [order-edit-wrong-balance-direction](./order-edit-wrong-balance-direction/) | Swapping to a cheaper item during an order edit prompts to collect more money instead of refunding the difference; script recomputes the diff correctly. | Diagnostic | [Read](https://www.allanninal.dev/medusa/order-edit-wrong-balance-direction/) |
| [order-edit-cancels-payment-collection](./order-edit-cancels-payment-collection/) | Since v2.7, editing quantity or price sets payment_status to not_paid and cancels the collection permanently; script finds canceled collections with active edits. | Diagnostic | [Read](https://www.allanninal.dev/medusa/order-edit-cancels-payment-collection/) |
| [draft-order-no-payment-collection](./draft-order-no-payment-collection/) | Draft orders have no cart id, so the create payment collection step fails and blocks manual payment; script detects draft orders stuck without one. | Diagnostic | [Read](https://www.allanninal.dev/medusa/draft-order-no-payment-collection/) |
| [order-summary-tax-excluded-bogus-refund](./order-summary-tax-excluded-bogus-refund/) | v2.10.1 excludes tax from accounting_total and pending_difference, auto-issuing partial refunds equal to the tax; script recomputes totals with tax included. | Diagnostic | [Read](https://www.allanninal.dev/medusa/order-summary-tax-excluded-bogus-refund/) |
| [stuck-active-order-change](./stuck-active-order-change/) | Editing fails with an active order change is required after upgrade because a prior OrderChange never reached a terminal status; script finds and clears it. | Reconciler | [Read](https://www.allanninal.dev/medusa/stuck-active-order-change/) |
| [fulfillment-status-stuck-delivered](./fulfillment-status-stuck-delivered/) | Processing a complete return and refund never flips fulfillment_status to returned; script cross checks return records against fulfillment_status. | Diagnostic | [Read](https://www.allanninal.dev/medusa/fulfillment-status-stuck-delivered/) |
| [cancel-fulfillment-negative-stock](./cancel-fulfillment-negative-stock/) | Canceling a fulfillment for an item with negative inventory_quantity throws a not enough stock error; script scans location levels for negative quantities. | Repair | [Read](https://www.allanninal.dev/medusa/cancel-fulfillment-negative-stock/) |
| [fulfillment-event-skipped-untracked-items](./fulfillment-event-skipped-untracked-items/) | Fulfillments on orders with manage_inventory false items never emit fulfillment_created, so shipment notifications silently skip; script checks for missing side effects. | Diagnostic | [Read](https://www.allanninal.dev/medusa/fulfillment-event-skipped-untracked-items/) |
| [buyget-promotion-not-applied-on-update](./buyget-promotion-not-applied-on-update/) | Buyget type promotions do not apply in the update cart promotions workflow even when conditions are met; script re-evaluates rules against cart contents. | Diagnostic | [Read](https://www.allanninal.dev/medusa/buyget-promotion-not-applied-on-update/) |
| [campaign-budget-usage-not-tracked](./campaign-budget-usage-not-tracked/) | Redeeming a buy X get Y promotion does not update the campaign budget's used counter, letting spend exceed budget; script recomputes usage from applied orders. | Reconciler | [Read](https://www.allanninal.dev/medusa/campaign-budget-usage-not-tracked/) |
| [promotion-ignores-channel-condition](./promotion-ignores-channel-condition/) | A promotion scoped to one sales channel applies store wide regardless of the cart's channel; script checks applied promotions against cart.sales_channel_id. | Diagnostic | [Read](https://www.allanninal.dev/medusa/promotion-ignores-channel-condition/) |
| [shipping-discount-stale-amount](./shipping-discount-stale-amount/) | Percentage off shipping promotions keep discounting an outdated shipping total when cart items change; script recomputes the promo against the current total. | Reconciler | [Read](https://www.allanninal.dev/medusa/shipping-discount-stale-amount/) |
| [draft-order-rejects-promotion-code](./draft-order-rejects-promotion-code/) | Applying a promotion code to a draft order fails even though the same code works on a regular cart; script applies the code via API and flags rejections. | Diagnostic | [Read](https://www.allanninal.dev/medusa/draft-order-rejects-promotion-code/) |
| [price-list-suppresses-default-price](./price-list-suppresses-default-price/) | calculated_price ignores default prices entirely once any price list exists, hiding correct fallback pricing; script compares default vs calculated price. | Diagnostic | [Read](https://www.allanninal.dev/medusa/price-list-suppresses-default-price/) |
| [expired-price-list-still-served](./expired-price-list-still-served/) | Storefront keeps charging an expired price list price after end_date passes; script flags price lists with a past end date still returned by calculated_price. | Diagnostic | [Read](https://www.allanninal.dev/medusa/expired-price-list-still-served/) |
| [multi-group-price-resolution-fails](./multi-group-price-resolution-fails/) | Customers belonging to more than one group get the default price instead of their group's price list override; script checks quoted price per test customer. | Diagnostic | [Read](https://www.allanninal.dev/medusa/multi-group-price-resolution-fails/) |
| [region-price-ignored](./region-price-ignored/) | A price explicitly scoped to a region_id is skipped for a currency only price, causing the wrong charge amount; script cross checks price rules vs served price. | Diagnostic | [Read](https://www.allanninal.dev/medusa/region-price-ignored/) |
| [workflow-execution-stuck-invoking](./workflow-execution-stuck-invoking/) | workflow_execution rows for long workflows stay invoking and sometimes flap in and out of the table; script polls for entries stuck past expected TTL. | Diagnostic | [Read](https://www.allanninal.dev/medusa/workflow-execution-stuck-invoking/) |
| [continue-on-failure-skips-compensation](./continue-on-failure-skips-compensation/) | Steps configured to continue on permanent failure never roll back, leaving orphaned created records; script cross references order state against expected outputs. | Reconciler | [Read](https://www.allanninal.dev/medusa/continue-on-failure-skips-compensation/) |
| [scheduled-job-runs-twice](./scheduled-job-runs-twice/) | A job configured with one cron interval fires twice per tick, duplicating side effects like emails or exports; script counts run timestamps for duplicates. | Diagnostic | [Read](https://www.allanninal.dev/medusa/scheduled-job-runs-twice/) |
| [scheduled-jobs-stop-after-uptime](./scheduled-jobs-stop-after-uptime/) | Long running instances silently stop triggering any cron job after some uptime under the workflow engine; script pings a heartbeat job's last run timestamp. | Diagnostic | [Read](https://www.allanninal.dev/medusa/scheduled-jobs-stop-after-uptime/) |
| [scheduled-jobs-sporadic-redis-deploy](./scheduled-jobs-sporadic-redis-deploy/) | Jobs run inconsistently on some hosting setups, leaving failed job records in Redis; script inspects the queue for stuck or failed entries. | Diagnostic | [Read](https://www.allanninal.dev/medusa/scheduled-jobs-sporadic-redis-deploy/) |
| [redis-event-bus-drops-events](./redis-event-bus-drops-events/) | Events like order.placed are not consistently delivered to subscribers, silently skipping notifications; script diffs expected vs fired events over a window. | Reconciler | [Read](https://www.allanninal.dev/medusa/redis-event-bus-drops-events/) |
| [events-race-subscriber-boot](./events-race-subscriber-boot/) | Events emitted immediately at startup race subscriber registration, causing missed handlers right after deploy; script checks for gaps right after a restart. | Diagnostic | [Read](https://www.allanninal.dev/medusa/events-race-subscriber-boot/) |
| [duplicate-emails-from-leftover-workaround](./duplicate-emails-from-leftover-workaround/) | An expired custom workaround keeps re-firing order.placed after the root bug was patched, sending duplicate emails per order; script counts notifications per order. | Diagnostic | [Read](https://www.allanninal.dev/medusa/duplicate-emails-from-leftover-workaround/) |
| [link-table-orphaned-on-rename](./link-table-orphaned-on-rename/) | Renaming a linked data model prompts dropping the old link table unless a third defineLink parameter is passed, orphaning records; script counts link rows vs referenced entities. | Reconciler | [Read](https://www.allanninal.dev/medusa/link-table-orphaned-on-rename/) |
| [no-hard-delete-for-link-rows](./no-hard-delete-for-link-rows/) | Deleting a linked entity leaves its row in the auto generated link table with no public delete method; script must call the dismiss step or raw query to clean up. | Reconciler | [Read](https://www.allanninal.dev/medusa/no-hard-delete-for-link-rows/) |
| [custom-link-no-cascade-delete](./custom-link-no-cascade-delete/) | Deleting a product leaves dangling rows in custom module link tables pointing at a nonexistent product id; script scans links for missing product ids. | Reconciler | [Read](https://www.allanninal.dev/medusa/custom-link-no-cascade-delete/) |
| [csv-import-stuck-preprocessing](./csv-import-stuck-preprocessing/) | CSV product import jobs stall indefinitely in preprocessing status with no completion event fired; script polls batch jobs for ones stuck past a timeout. | Diagnostic | [Read](https://www.allanninal.dev/medusa/csv-import-stuck-preprocessing/) |
| [csv-import-ignores-inventory-quantity](./csv-import-ignores-inventory-quantity/) | Importing products via CSV leaves every imported variant at zero stock regardless of the source quantity column; script compares CSV quantities to resulting levels. | Repair | [Read](https://www.allanninal.dev/medusa/csv-import-ignores-inventory-quantity/) |
| [duplicate-product-scrambles-variants](./duplicate-product-scrambles-variants/) | Duplicating a product mismatches variant and option value combinations versus the source; script diffs option sets between original and duplicate. | Diagnostic | [Read](https://www.allanninal.dev/medusa/duplicate-product-scrambles-variants/) |
| [duplicate-product-barcode-conflict](./duplicate-product-barcode-conflict/) | Product duplication throws a database unique index violation on variant EAN or barcode; script scans variants for duplicate barcode values across products. | Diagnostic | [Read](https://www.allanninal.dev/medusa/duplicate-product-barcode-conflict/) |

More fixes land as the guides are published. Watch or star the repo to follow along.

## Running the tests

The decision logic in every fix is a pure function with no network calls, so the tests run anywhere.

```bash
# Python
pip install pytest
pytest

# Node
node --test
```

## A note on safety

These scripts can change orders, inventory, prices, and issue refunds. Always run with `DRY_RUN=true` first, read the output, and confirm it is correct before you let a script write. Test against a staging store when you can.

## Work with me

Fighting a Medusa bug you would rather hand off? That is what I do.

- GitHub: [github.com/allanninal](https://github.com/allanninal)
- LinkedIn: [in/allanninal](https://www.linkedin.com/in/allanninal/)
- Support the work: [ko-fi.com/allanninal](https://ko-fi.com/allanninal)

## License

MIT. Use it, change it, ship it.
