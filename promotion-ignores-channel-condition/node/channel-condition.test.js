import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromotionAllowedForChannel, findLeaks } from "./find-channel-leaks.js";

const rule = (over = {}) => ({ attribute: "sales_channel_id", operator: "eq", values: ["sc_web"], ...over });

test("no channel rules means allowed anywhere", () => {
  assert.equal(isPromotionAllowedForChannel([], "sc_pos"), true);
});

test("eq allows matching channel", () => {
  assert.equal(isPromotionAllowedForChannel([rule()], "sc_web"), true);
});

test("eq blocks other channel", () => {
  assert.equal(isPromotionAllowedForChannel([rule()], "sc_pos"), false);
});

test("in allows any listed channel", () => {
  const r = rule({ operator: "in", values: ["sc_web", "sc_wholesale"] });
  assert.equal(isPromotionAllowedForChannel([r], "sc_wholesale"), true);
});

test("ne blocks the excluded channel", () => {
  const r = rule({ operator: "ne", values: ["sc_pos"] });
  assert.equal(isPromotionAllowedForChannel([r], "sc_pos"), false);
});

test("nin allows channel not in list", () => {
  const r = rule({ operator: "nin", values: ["sc_pos"] });
  assert.equal(isPromotionAllowedForChannel([r], "sc_web"), true);
});

test("missing cart channel fails closed", () => {
  assert.equal(isPromotionAllowedForChannel([rule()], null), false);
});

test("unknown operator fails closed", () => {
  assert.equal(isPromotionAllowedForChannel([rule({ operator: "regex" })], "sc_web"), false);
});

test("all channel rules must pass", () => {
  const rules = [rule({ values: ["sc_web"] }), rule({ operator: "ne", values: ["sc_web"] })];
  assert.equal(isPromotionAllowedForChannel(rules, "sc_web"), false);
});

test("findLeaks flags order outside promotion channel", () => {
  const promotions = [{ id: "promo_1", code: "WEB10", rules: [rule()] }];
  const orders = [{
    id: "order_1",
    sales_channel_id: "sc_pos",
    total: 100,
    currency_code: "usd",
    promotions: [{ id: "promo_1", code: "WEB10", rules: [rule()] }],
  }];
  const leaks = findLeaks(promotions, orders, { sc_pos: "Point of Sale" });
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].orderId, "order_1");
  assert.deepEqual(leaks[0].expectedSalesChannelIds, ["sc_web"]);
});

test("findLeaks ignores orders in the right channel", () => {
  const promotions = [{ id: "promo_1", code: "WEB10", rules: [rule()] }];
  const orders = [{
    id: "order_2",
    sales_channel_id: "sc_web",
    total: 50,
    currency_code: "usd",
    promotions: [{ id: "promo_1", code: "WEB10", rules: [rule()] }],
  }];
  assert.deepEqual(findLeaks(promotions, orders, {}), []);
});

test("findLeaks ignores promotions without channel rules", () => {
  const promotions = [{ id: "promo_2", code: "SALE5", rules: [] }];
  const orders = [{
    id: "order_3",
    sales_channel_id: "sc_pos",
    total: 20,
    currency_code: "usd",
    promotions: [{ id: "promo_2", code: "SALE5", rules: [] }],
  }];
  assert.deepEqual(findLeaks(promotions, orders, {}), []);
});
