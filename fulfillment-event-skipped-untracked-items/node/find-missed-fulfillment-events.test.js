import { test } from "node:test";
import assert from "node:assert/strict";
import { isFulfillmentEventLikelyMissed } from "./find-missed-fulfillment-events.js";

const fulfillment = (over = {}) => ({
  id: "ful_1",
  items: [{ line_item_id: "item_1" }],
  ...over,
});

test("missed when all items untracked and not notified", () => {
  const items = { item_1: { manage_inventory: false } };
  assert.equal(isFulfillmentEventLikelyMissed(fulfillment(), items, new Set()), true);
});

test("not missed when already notified", () => {
  const items = { item_1: { manage_inventory: false } };
  assert.equal(isFulfillmentEventLikelyMissed(fulfillment(), items, new Set(["ful_1"])), false);
});

test("not missed when item is tracked", () => {
  const items = { item_1: { manage_inventory: true } };
  assert.equal(isFulfillmentEventLikelyMissed(fulfillment(), items, new Set()), false);
});

test("not missed when mixed tracked and untracked", () => {
  const f = fulfillment({ items: [{ line_item_id: "item_1" }, { line_item_id: "item_2" }] });
  const items = { item_1: { manage_inventory: false }, item_2: { manage_inventory: true } };
  assert.equal(isFulfillmentEventLikelyMissed(f, items, new Set()), false);
});

test("missing lookup defaults to untracked", () => {
  assert.equal(isFulfillmentEventLikelyMissed(fulfillment(), {}, new Set()), true);
});

test("no items is not missed", () => {
  assert.equal(isFulfillmentEventLikelyMissed(fulfillment({ items: [] }), {}, new Set()), false);
});
