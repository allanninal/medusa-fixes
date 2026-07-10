# Promotion not applying

A Medusa promotion can look perfectly configured, `status: "active"`, budget left in its campaign, and still never apply to a real cart. Eligibility rules on the promotion (customer group, region, currency) and target or buy rules on its application method (product, variant, collection) are each checked as an attribute, an operator, and a list of values against the live cart. If one attribute path is wrong, one operator is too strict, or one value points at an id that no longer exists, that single rule evaluates to false and Medusa skips the whole promotion with no error and a normal 200 response. This script diffs the promotion's full rule graph against a real cart and reports the exact mismatched rule and the admin fix.

**Full guide with diagrams:** https://www.allanninal.dev/medusa/promotion-not-applying-rules-mismatch/

## Run it

```bash
export MEDUSA_BACKEND_URL="http://localhost:9000"
export MEDUSA_ADMIN_EMAIL="admin@example.com"
export MEDUSA_ADMIN_PASSWORD="supersecret"
export PROMOTION_ID="promo_01..."
export CART_ID="cart_01..."
export DRY_RUN="true"

python promotion-not-applying-rules-mismatch/python/audit_promotion_rules.py
node   promotion-not-applying-rules-mismatch/node/audit-promotion-rules.js
```

`rule_matches_cart` is a pure function: it resolves a rule's `attribute` as a dot path into a cart context object (built from the cart's currency, region, customer groups, and item product ids), then applies the rule's `operator` against its `values`. It returns `false` and never throws on an unresolved path, empty values, or an incompatible operator and type, mirroring Medusa's real fail-closed rule evaluation. `audit_promotion` runs that check against every rule in `rules`, `target_rules`, and `buy_rules`, plus the promotion's own `status`, and returns one report per mismatch. The script never writes to your store. It only logs the `POST /admin/promotions/:id/rules/batch` or `/target-rules/batch` payload a human should apply, because eligibility is a merchant decision the tool cannot safely guess. `DRY_RUN` gates even that logging distinction.

## Test

```bash
pytest promotion-not-applying-rules-mismatch/python
node --test promotion-not-applying-rules-mismatch/node
```
