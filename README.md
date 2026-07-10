# medusa-fixes

Small, focused scripts that detect and repair the everyday problems that hit real
[Medusa.js](https://medusajs.com) (v2) stores: hidden products, missing region
prices, stuck inventory reservations, carts that will not complete, orders that
never fulfill, promotions that will not apply, broken module links, and missed
background jobs.

Every fix ships in **both Python and Node.js**, is **safe by default** (a
`DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has
a **pure decision function** with unit tests, so you can trust the logic before
you point it at a live store.

Each fix has a full write-up with diagrams on
**[allanninal.dev/medusa](https://www.allanninal.dev/medusa/)**.

## How the scripts authenticate

The scripts talk to the Medusa **Admin API**. They read configuration from the
environment:

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export DRY_RUN="true"   # set to "false" to actually write
```

They exchange the email and password for a JWT at
`POST /auth/user/emailpass`, then call `/admin/*` routes with an
`Authorization: Bearer <token>` header. The Node scripts use
[`@medusajs/js-sdk`](https://docs.medusajs.com/resources/js-sdk); the Python
scripts use `requests`.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
| [Storefront shows no products](storefront-shows-no-products-missing-publishable-key/) | A Store API request with no publishable API key returns an empty list. Detect the missing key and wire it to a sales channel. | Diagnostic | [guide](https://www.allanninal.dev/medusa/storefront-shows-no-products-missing-publishable-key/) |
| [Publishable key not linked to a sales channel](publishable-key-not-linked-to-a-sales-channel/) | The key exists but points at no sales channel, so products stay hidden. Link it. | Diagnostic | [guide](https://www.allanninal.dev/medusa/publishable-key-not-linked-to-a-sales-channel/) |
| [Store requests blocked by CORS](store-requests-blocked-by-cors/) | The storefront gets CORS errors from the Store API. Probe the endpoints and report the gap. | Diagnostic | [guide](https://www.allanninal.dev/medusa/store-requests-blocked-by-cors/) |
| [Product has no price in a region](product-has-no-price-in-a-region/) | A variant has no price in the region currency, so it cannot be bought there. Find the gaps. | Reconciler | [guide](https://www.allanninal.dev/medusa/product-has-no-price-in-a-region/) |
| [Price list not applied at checkout](price-list-not-applied-at-checkout/) | A sale price list is set but the cart still shows list price. Check its status and dates. | Diagnostic | [guide](https://www.allanninal.dev/medusa/price-list-not-applied-at-checkout/) |
| [Wrong currency shown for a region](wrong-currency-shown-for-a-region/) | The region currency and the shown price currency disagree. Flag the mismatched prices. | Diagnostic | [guide](https://www.allanninal.dev/medusa/wrong-currency-shown-for-a-region/) |
| [Tax-inclusive pricing shows wrong totals](tax-inclusive-pricing-shows-wrong-totals/) | Tax-inclusive and tax-exclusive prices are mixed, so totals look off. Detect the mismatch. | Diagnostic | [guide](https://www.allanninal.dev/medusa/tax-inclusive-pricing-shows-wrong-totals/) |
| [Variant not purchasable, no inventory level](variant-not-purchasable-no-inventory-level/) | A tracked variant has no inventory level at the location, so it reads out of stock. Create it. | Reconciler | [guide](https://www.allanninal.dev/medusa/variant-not-purchasable-no-inventory-level/) |
| [Sales channel not linked to a stock location](sales-channel-not-linked-to-a-stock-location/) | The channel has no stock location, so nothing is in stock there. Link a location. | Diagnostic | [guide](https://www.allanninal.dev/medusa/sales-channel-not-linked-to-a-stock-location/) |
| [Stuck reservations after cancelled carts](stuck-reservations-after-cancelled-carts/) | Cancelled carts left reservations that still hold stock. Release the stale ones. | Reconciler | [guide](https://www.allanninal.dev/medusa/stuck-reservations-after-cancelled-carts/) |
| [Oversold variant goes negative](oversold-variant-goes-negative/) | Stock dropped below zero after a race. Reset the oversold variants to a real count. | Repair | [guide](https://www.allanninal.dev/medusa/oversold-variant-goes-negative/) |
| [Inventory not managed, item never sells out](inventory-not-managed-never-sells-out/) | manage_inventory is off, so a variant never runs out. Detect them and turn it on. | Diagnostic | [guide](https://www.allanninal.dev/medusa/inventory-not-managed-never-sells-out/) |
| [Cart completion fails, no payment provider](cart-completion-fails-no-payment-provider/) | The region has no payment provider, so checkout cannot finish. Find the empty regions. | Repair | [guide](https://www.allanninal.dev/medusa/cart-completion-fails-no-payment-provider/) |
| [No shipping option for the cart](no-shipping-option-for-the-cart/) | A service zone gap leaves the cart with no shipping option. Detect the uncovered regions. | Diagnostic | [guide](https://www.allanninal.dev/medusa/no-shipping-option-for-the-cart/) |
| [Abandoned carts pile up](abandoned-carts-pile-up/) | Old carts that never completed clutter the database. Report the stale ones for cleanup. | Reconciler | [guide](https://www.allanninal.dev/medusa/abandoned-carts-pile-up/) |
| [Stale cart prices after a price change](stale-cart-prices-after-a-price-change/) | A price change did not reach open carts. Flag the carts still holding the old price. | Reconciler | [guide](https://www.allanninal.dev/medusa/stale-cart-prices-after-a-price-change/) |
| [Order stuck not fulfilled past SLA](order-stuck-not-fulfilled-past-sla/) | A paid order sat unfulfilled past your promise. Tag the overdue ones for review. | Diagnostic | [guide](https://www.allanninal.dev/medusa/order-stuck-not-fulfilled-past-sla/) |
| [Payment captured but order not paid](payment-captured-but-order-not-paid/) | The capture went through but the order still reads unpaid. Reconcile the payment status. | Reconciler | [guide](https://www.allanninal.dev/medusa/payment-captured-but-order-not-paid/) |
| [Fulfillment without a tracking number](fulfillment-without-a-tracking-number/) | A fulfillment shipped with no tracking number. Flag the ones missing it. | Diagnostic | [guide](https://www.allanninal.dev/medusa/fulfillment-without-a-tracking-number/) |
| [Refund not reflected on the order](refund-not-reflected-on-the-order/) | A refund in the provider never updated the order. Record it so totals tie out. | Reconciler | [guide](https://www.allanninal.dev/medusa/refund-not-reflected-on-the-order/) |
| [Promotion not applying](promotion-not-applying-rules-mismatch/) | A promotion never applies because its rules do not match the cart. Check the rules. | Diagnostic | [guide](https://www.allanninal.dev/medusa/promotion-not-applying-rules-mismatch/) |
| [Campaign budget exceeded but still applies](campaign-budget-exceeded-still-applies/) | A campaign past its budget keeps discounting. Detect and stop it. | Diagnostic | [guide](https://www.allanninal.dev/medusa/campaign-budget-exceeded-still-applies/) |
| [Duplicate promotion codes](duplicate-promotion-codes/) | Two promotions share a code and collide. Report the duplicates. | Diagnostic | [guide](https://www.allanninal.dev/medusa/duplicate-promotion-codes/) |
| [Linked data missing after a link migration](linked-data-missing-after-link-migration/) | A module link was added but never migrated, so linked data is missing. Detect it. | Diagnostic | [guide](https://www.allanninal.dev/medusa/linked-data-missing-after-link-migration/) |
| [Orphaned records after a link delete](orphaned-records-after-a-link-delete/) | Deleting a link left dangling records behind. Find and clean the orphans. | Reconciler | [guide](https://www.allanninal.dev/medusa/orphaned-records-after-a-link-delete/) |
| [Variant options mismatch blocks creation](variant-options-mismatch-blocks-creation/) | A variant is missing an option value, so creation fails. Detect the incomplete variants. | Diagnostic | [guide](https://www.allanninal.dev/medusa/variant-options-mismatch-blocks-creation/) |
| [Duplicate product handles from import](duplicate-product-handles-from-import/) | An import created products with the same handle. Report the conflicts. | Reconciler | [guide](https://www.allanninal.dev/medusa/duplicate-product-handles-from-import/) |
| [Broken product image links](broken-product-image-links/) | Product images point at files that no longer load. Detect the broken ones. | Diagnostic | [guide](https://www.allanninal.dev/medusa/broken-product-image-links/) |
| [Events lost without the Redis event bus](events-lost-without-redis-event-bus/) | In production the in-memory event bus drops events, so side effects are missed. Reconcile them. | Reconciler | [guide](https://www.allanninal.dev/medusa/events-lost-without-redis-event-bus/) |
| [Workflow left half done](workflow-left-half-done/) | A workflow failed mid-run and compensation did not undo it. Find the half-done records. | Reconciler | [guide](https://www.allanninal.dev/medusa/workflow-left-half-done/) |
| [Scheduled job did not run](scheduled-job-did-not-run/) | A scheduled job silently skipped, so its work is missing. Detect the gap and catch up. | Reconciler | [guide](https://www.allanninal.dev/medusa/scheduled-job-did-not-run/) |
| [Subscriber fails silently on order placed](subscriber-fails-silently-on-order-placed/) | An order.placed subscriber threw and was swallowed. Find orders missing the side effect. | Diagnostic | [guide](https://www.allanninal.dev/medusa/subscriber-fails-silently-on-order-placed/) |
| [Backfill external id for reconciliation](backfill-external-id-for-reconciliation/) | Old orders lack the external id needed to match your other systems. Backfill it safely. | Repair | [guide](https://www.allanninal.dev/medusa/backfill-external-id-for-reconciliation/) |
| [Draft orders never completed](draft-orders-never-completed/) | Draft orders that were never completed pile up. Report the stale ones. | Reconciler | [guide](https://www.allanninal.dev/medusa/draft-orders-never-completed/) |
