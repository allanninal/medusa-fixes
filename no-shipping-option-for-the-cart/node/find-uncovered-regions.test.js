import { test } from "node:test";
import assert from "node:assert/strict";
import { findUncoveredRegions } from "./find-uncovered-regions.js";

const region = (over = {}) => ({ id: "reg_1", countryCodes: ["us"], salesChannelIds: ["sc_1"], ...over });
const geoZone = (countryCode, type = "country") => ({ type, countryCode });
const option = (id = "so_1", rules = []) => ({ id, rules });
const loc = (salesChannelIds, serviceZones) => ({
  id: "sloc_1",
  salesChannelIds,
  fulfillmentSets: [{ serviceZones }],
});

test("country with matching geo zone and options is covered", () => {
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [option()] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, []);
});

test("country with no geo zone match is reported", () => {
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("ca")], shippingOptions: [option()] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_1", countryCode: "us", reason: "no_geo_zone_match" }]);
});

test("matched zone with no shipping options is reported", () => {
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_1", countryCode: "us", reason: "zone_matched_no_shipping_options" }]);
});

test("matched zone where all options are excluded by a subtotal rule is reported", () => {
  const excludedOption = option("so_1", [{ attribute: "cart.subtotal", operator: "gte", value: 10000 }]);
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [excludedOption] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_1", countryCode: "us", reason: "zone_matched_no_shipping_options" }]);
});

test("stock location not linked to the sales channel is ignored", () => {
  const locations = [loc(["sc_other"], [{ geoZones: [geoZone("us")], shippingOptions: [option()] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_1", countryCode: "us", reason: "no_geo_zone_match" }]);
});

test("multiple countries each get their own verdict", () => {
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [option()] }])];
  const gaps = findUncoveredRegions([region({ countryCodes: ["us", "ca"] })], locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_1", countryCode: "ca", reason: "no_geo_zone_match" }]);
});

test("zone with a non subtotal rule is still usable", () => {
  const nonBlockingOption = option("so_1", [{ attribute: "customer.group", operator: "eq", value: "wholesale" }]);
  const locations = [loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [nonBlockingOption] }])];
  const gaps = findUncoveredRegions([region()], locations);
  assert.deepEqual(gaps, []);
});

test("multiple sales channels are evaluated independently", () => {
  const locations = [
    loc(["sc_1"], [{ geoZones: [geoZone("us")], shippingOptions: [option()] }]),
    loc(["sc_2"], [{ geoZones: [geoZone("ca")], shippingOptions: [option()] }]),
  ];
  const regions = [region({ id: "reg_1", countryCodes: ["us"], salesChannelIds: ["sc_1", "sc_2"] })];
  const gaps = findUncoveredRegions(regions, locations);
  assert.deepEqual(gaps, [{ salesChannelId: "sc_2", countryCode: "us", reason: "no_geo_zone_match" }]);
});
