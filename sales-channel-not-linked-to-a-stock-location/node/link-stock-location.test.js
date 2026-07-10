import { test } from "node:test";
import assert from "node:assert/strict";
import { planStockLocationLinks } from "./link-stock-location.js";

const sc = (over = {}) => ({ id: "sc_1", name: "Default channel", stock_locations: [], ...over });
const loc = (id, name = "Main warehouse") => ({ id, name });

test("channel with linked location needs no link", () => {
  const plans = planStockLocationLinks([sc({ stock_locations: [{ id: "sloc_1" }] })], [loc("sloc_1")]);
  assert.deepEqual(plans, [{
    sales_channel_id: "sc_1",
    sales_channel_name: "Default channel",
    needs_link: false,
    suggested_location_id: null,
  }]);
});

test("channel with zero locations and no default and multiple locations is flagged", () => {
  const plans = planStockLocationLinks([sc()], [loc("sloc_1"), loc("sloc_2")]);
  assert.deepEqual(plans, [{
    sales_channel_id: "sc_1",
    sales_channel_name: "Default channel",
    needs_link: true,
    suggested_location_id: null,
  }]);
});

test("channel with zero locations and exactly one available location is suggested", () => {
  const plans = planStockLocationLinks([sc()], [loc("sloc_1")]);
  assert.deepEqual(plans, [{
    sales_channel_id: "sc_1",
    sales_channel_name: "Default channel",
    needs_link: true,
    suggested_location_id: "sloc_1",
  }]);
});

test("explicit default location wins even with multiple available", () => {
  const plans = planStockLocationLinks([sc()], [loc("sloc_1"), loc("sloc_2")], "sloc_2");
  assert.equal(plans[0].suggested_location_id, "sloc_2");
});

test("multiple channels each get their own plan", () => {
  const plans = planStockLocationLinks(
    [sc({ id: "sc_1", stock_locations: [{ id: "sloc_1" }] }), sc({ id: "sc_2", stock_locations: [] })],
    [loc("sloc_1")],
  );
  assert.equal(plans[0].needs_link, false);
  assert.equal(plans[1].needs_link, true);
  assert.equal(plans[1].suggested_location_id, "sloc_1");
});

test("channel with zero locations and no locations at all is flagged", () => {
  const plans = planStockLocationLinks([sc()], []);
  assert.equal(plans[0].needs_link, true);
  assert.equal(plans[0].suggested_location_id, null);
});
