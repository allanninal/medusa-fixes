import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseZeroStockMismatch } from "./diagnose-multi-channel-zero-stock.js";

const LEVELS = {
  sloc_1: { stockedQuantity: 20, reservedQuantity: 5 },
  sloc_2: { stockedQuantity: 10, reservedQuantity: 0 },
};
const LOCATIONS_BY_CHANNEL = {
  sc_1: ["sloc_1"],
  sc_2: ["sloc_2"],
};

test("single channel ok is not a bug", () => {
  const result = diagnoseZeroStockMismatch(["sc_1"], LEVELS, LOCATIONS_BY_CHANNEL, 15);
  assert.deepEqual(result, { isBug: false, expectedAvailable: 15, reason: "ok" });
});

test("multi channel healthy is not a bug", () => {
  const result = diagnoseZeroStockMismatch(["sc_1", "sc_2"], LEVELS, LOCATIONS_BY_CHANNEL, 25);
  assert.deepEqual(result, { isBug: false, expectedAvailable: 25, reason: "ok" });
});

test("multi channel zero stock is the bug", () => {
  const result = diagnoseZeroStockMismatch(["sc_1", "sc_2"], LEVELS, LOCATIONS_BY_CHANNEL, 0);
  assert.deepEqual(result, { isBug: true, expectedAvailable: 25, reason: "multi-channel-key-zero-stock" });
});

test("single channel zero stock is not flagged as the bug", () => {
  const result = diagnoseZeroStockMismatch(["sc_1"], LEVELS, LOCATIONS_BY_CHANNEL, 0);
  assert.equal(result.isBug, false);
});

test("genuinely out of stock across all channels", () => {
  const emptyLevels = {
    sloc_1: { stockedQuantity: 0, reservedQuantity: 0 },
    sloc_2: { stockedQuantity: 3, reservedQuantity: 3 },
  };
  const result = diagnoseZeroStockMismatch(["sc_1", "sc_2"], emptyLevels, LOCATIONS_BY_CHANNEL, 0);
  assert.deepEqual(result, { isBug: false, expectedAvailable: 0, reason: "genuinely-out-of-stock" });
});

test("reserved never pushes a location negative", () => {
  const overReserved = { sloc_1: { stockedQuantity: 2, reservedQuantity: 9 } };
  const result = diagnoseZeroStockMismatch(["sc_1"], overReserved, { sc_1: ["sloc_1"] }, 0);
  assert.equal(result.expectedAvailable, 0);
});

test("unknown channel contributes no locations", () => {
  const result = diagnoseZeroStockMismatch(["sc_1", "sc_missing"], LEVELS, LOCATIONS_BY_CHANNEL, 20);
  assert.equal(result.expectedAvailable, 15);
});

test("missing location level is skipped not errored", () => {
  const partialByChannel = { sc_1: ["sloc_1", "sloc_unknown"] };
  const result = diagnoseZeroStockMismatch(["sc_1"], LEVELS, partialByChannel, 15);
  assert.deepEqual(result, { isBug: false, expectedAvailable: 15, reason: "ok" });
});
