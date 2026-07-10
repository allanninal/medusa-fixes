import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleMatchesCart, buildCartContext, auditPromotion } from "./audit-promotion-rules.js";

const CONTEXT = {
  currency_code: "eur",
  region: { id: "reg_eu" },
  region_id: "reg_eu",
  customer: { groups: [{ id: "pcgrp_vip" }] },
  items: { product: { id: ["prod_1", "prod_2"] } },
};

const rule = (over = {}) => ({ id: "prule_1", attribute: "currency_code", operator: "eq", values: ["eur"], ...over });

test("eq matches when value present", () => {
  assert.equal(ruleMatchesCart(rule(), CONTEXT), true);
});

test("eq fails on currency mismatch", () => {
  assert.equal(ruleMatchesCart(rule({ values: ["usd"] }), CONTEXT), false);
});

test("in matches any of multiple values", () => {
  const r = rule({ attribute: "customer.groups.id", operator: "in", values: ["pcgrp_vip", "pcgrp_wholesale"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), true);
});

test("wrong attribute path never matches", () => {
  const r = rule({ attribute: "customer_group_id", operator: "eq", values: ["pcgrp_vip"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), false);
});

test("ne true when no intersection", () => {
  const r = rule({ attribute: "currency_code", operator: "ne", values: ["usd"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), true);
});

test("target rule on deleted product never matches", () => {
  const r = rule({ attribute: "items.product.id", operator: "in", values: ["prod_deleted"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), false);
});

test("target rule matches existing cart item", () => {
  const r = rule({ attribute: "items.product.id", operator: "in", values: ["prod_1"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), true);
});

test("empty values never matches", () => {
  assert.equal(ruleMatchesCart(rule({ values: [] }), CONTEXT), false);
});

test("unresolved path returns false not throws", () => {
  const r = rule({ attribute: "does.not.exist", operator: "eq", values: ["x"] });
  assert.equal(ruleMatchesCart(r, CONTEXT), false);
});

test("gte numeric comparison", () => {
  const ctx = { ...CONTEXT, item_total: 100 };
  assert.equal(ruleMatchesCart(rule({ attribute: "item_total", operator: "gte", values: [50] }), ctx), true);
  assert.equal(ruleMatchesCart(rule({ attribute: "item_total", operator: "gte", values: [150] }), ctx), false);
});

test("audit flags target rule on deleted product", () => {
  const promotion = {
    id: "promo_1",
    status: "active",
    rules: [],
    application_method: { target_rules: [rule({ attribute: "items.product.id", operator: "in", values: ["prod_deleted"] })] },
  };
  const reports = auditPromotion(promotion, CONTEXT);
  assert.equal(reports.length, 1);
  assert.match(reports[0].reason, /target rule/);
});

test("audit reports nothing when all rules match", () => {
  const promotion = {
    id: "promo_2",
    status: "active",
    rules: [rule()],
    application_method: { target_rules: [rule({ attribute: "items.product.id", operator: "in", values: ["prod_1"] })] },
  };
  assert.deepEqual(auditPromotion(promotion, CONTEXT), []);
});

test("audit flags inactive status", () => {
  const promotion = { id: "promo_3", status: "draft", rules: [], application_method: {} };
  const reports = auditPromotion(promotion, CONTEXT);
  assert.equal(reports.length, 1);
  assert.match(reports[0].reason, /not active/);
});

test("buildCartContext shapes product ids", () => {
  const cart = { currency_code: "eur", region_id: "reg_eu", items: [{ product_id: "prod_1" }, { product_id: "prod_2" }] };
  const ctx = buildCartContext(cart, ["pcgrp_vip"]);
  assert.deepEqual(ctx.items.product.id, ["prod_1", "prod_2"]);
  assert.deepEqual(ctx.customer.groups, [{ id: "pcgrp_vip" }]);
});
