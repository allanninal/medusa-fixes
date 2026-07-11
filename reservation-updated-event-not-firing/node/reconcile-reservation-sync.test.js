import { test } from "node:test";
import assert from "node:assert/strict";
import { diffReservationSync, locationLevelMismatches } from "./reconcile-reservation-sync.js";

const res = (over = {}) => ({
  id: "res_1",
  quantity: 5,
  location_id: "sloc_1",
  updated_at: "2026-07-10T00:00:00Z",
  ...over,
});

test("flags reservation missing from last synced", () => {
  const result = diffReservationSync([res()], {});
  assert.deepEqual(result, [{ id: "res_1", drift: 5, staleSince: "2026-07-10T00:00:00Z" }]);
});

test("flags reservation when quantity changed", () => {
  const lastSynced = { res_1: { quantity: 3, updated_at: "2026-07-01T00:00:00Z" } };
  const result = diffReservationSync([res({ quantity: 7 })], lastSynced);
  assert.deepEqual(result, [{ id: "res_1", drift: 4, staleSince: "2026-07-01T00:00:00Z" }]);
});

test("no drift when quantity matches", () => {
  const lastSynced = { res_1: { quantity: 5, updated_at: "2026-07-01T00:00:00Z" } };
  const result = diffReservationSync([res()], lastSynced);
  assert.deepEqual(result, []);
});

test("negative drift when quantity decreased", () => {
  const lastSynced = { res_1: { quantity: 9, updated_at: "2026-07-01T00:00:00Z" } };
  const result = diffReservationSync([res({ quantity: 2 })], lastSynced);
  assert.deepEqual(result, [{ id: "res_1", drift: -7, staleSince: "2026-07-01T00:00:00Z" }]);
});

test("multiple reservations only flags changed ones", () => {
  const lastSynced = {
    res_1: { quantity: 5, updated_at: "2026-07-01T00:00:00Z" },
    res_2: { quantity: 1, updated_at: "2026-07-02T00:00:00Z" },
  };
  const live = [res({ id: "res_1", quantity: 5 }), res({ id: "res_2", quantity: 3 })];
  const result = diffReservationSync(live, lastSynced);
  assert.deepEqual(result, [{ id: "res_2", drift: 2, staleSince: "2026-07-02T00:00:00Z" }]);
});

test("empty live list returns empty", () => {
  const result = diffReservationSync([], { res_1: { quantity: 5, updated_at: "2026-07-01T00:00:00Z" } });
  assert.deepEqual(result, []);
});

test("location level mismatch flagged when sums disagree", () => {
  const reservationsByLocation = { sloc_1: [{ quantity: 3, inventory_item_id: "iitem_1" }] };
  const levels = [{ location_id: "sloc_1", inventory_item_id: "iitem_1", reserved_quantity: 5 }];
  const result = locationLevelMismatches(reservationsByLocation, levels);
  assert.deepEqual(result, [{ location_id: "sloc_1", inventory_item_id: "iitem_1", reserved_quantity: 5, live_sum: 3 }]);
});

test("location level matches when sums agree", () => {
  const reservationsByLocation = {
    sloc_1: [
      { quantity: 3, inventory_item_id: "iitem_1" },
      { quantity: 2, inventory_item_id: "iitem_1" },
    ],
  };
  const levels = [{ location_id: "sloc_1", inventory_item_id: "iitem_1", reserved_quantity: 5 }];
  const result = locationLevelMismatches(reservationsByLocation, levels);
  assert.deepEqual(result, []);
});

test("location level ignores other inventory items", () => {
  const reservationsByLocation = { sloc_1: [{ quantity: 3, inventory_item_id: "iitem_other" }] };
  const levels = [{ location_id: "sloc_1", inventory_item_id: "iitem_1", reserved_quantity: 0 }];
  const result = locationLevelMismatches(reservationsByLocation, levels);
  assert.deepEqual(result, []);
});
