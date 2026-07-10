import { test } from "node:test";
import assert from "node:assert/strict";
import { findRegionsWithoutWorkingPayment } from "./find-regions-without-payment.js";

const region = (over = {}) => ({
  id: "reg_1",
  name: "Europe",
  linkedProviderIds: ["pp_stripe_stripe"],
  enabledProviderIds: ["pp_stripe_stripe"],
  ...over,
});

test("region with working provider is covered", () => {
  const gaps = findRegionsWithoutWorkingPayment([region()]);
  assert.deepEqual(gaps, []);
});

test("region with no linked provider is reported", () => {
  const gaps = findRegionsWithoutWorkingPayment([region({ linkedProviderIds: [] })]);
  assert.deepEqual(gaps, [{ regionId: "reg_1", regionName: "Europe", reason: "no_provider_linked" }]);
});

test("region with linked provider not enabled is reported", () => {
  const gaps = findRegionsWithoutWorkingPayment([
    region({ linkedProviderIds: ["pp_stripe_stripe"], enabledProviderIds: [] }),
  ]);
  assert.deepEqual(gaps, [{ regionId: "reg_1", regionName: "Europe", reason: "linked_provider_not_enabled" }]);
});

test("region with one of several providers working is covered", () => {
  const gaps = findRegionsWithoutWorkingPayment([
    region({ linkedProviderIds: ["pp_stripe_stripe", "pp_manual_manual"], enabledProviderIds: ["pp_manual_manual"] }),
  ]);
  assert.deepEqual(gaps, []);
});

test("multiple regions each get their own verdict", () => {
  const regions = [
    region({ id: "reg_1", name: "Europe" }),
    region({ id: "reg_2", name: "Asia", linkedProviderIds: [], enabledProviderIds: [] }),
  ];
  const gaps = findRegionsWithoutWorkingPayment(regions);
  assert.deepEqual(gaps, [{ regionId: "reg_2", regionName: "Asia", reason: "no_provider_linked" }]);
});

test("missing keys default to no_provider_linked", () => {
  const gaps = findRegionsWithoutWorkingPayment([{ id: "reg_3", name: "Oceania" }]);
  assert.deepEqual(gaps, [{ regionId: "reg_3", regionName: "Oceania", reason: "no_provider_linked" }]);
});
