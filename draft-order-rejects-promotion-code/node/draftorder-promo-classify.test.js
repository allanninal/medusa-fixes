import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPromoRejection } from "./fix-draft-order-promo-code.js";

const draftOrder = (over = {}) => ({
  status: "draft",
  is_draft_order: true,
  order_change: { status: "pending", canceled_at: null, confirmed_at: null, declined_at: null },
  ...over,
});

const promo = (over = {}) => ({ code: "SAVE10", status: "active", ...over });

test("ok when edit session active and promo active", () => {
  const result = classifyPromoRejection(draftOrder(), [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "ok" }]);
});

test("no_active_edit_session when order_change missing", () => {
  const order = draftOrder({ order_change: null });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "no_active_edit_session" }]);
});

test("edit_session_inactive when confirmed", () => {
  const order = draftOrder({ order_change: { status: "confirmed", canceled_at: null, confirmed_at: "2026-07-01T00:00:00Z", declined_at: null } });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "edit_session_inactive" }]);
});

test("edit_session_inactive when canceled", () => {
  const order = draftOrder({ order_change: { status: "canceled", canceled_at: "2026-07-01T00:00:00Z", confirmed_at: null, declined_at: null } });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "edit_session_inactive" }]);
});

test("edit_session_inactive when declined", () => {
  const order = draftOrder({ order_change: { status: "declined", canceled_at: null, confirmed_at: null, declined_at: "2026-07-01T00:00:00Z" } });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "edit_session_inactive" }]);
});

test("not_draft_order when status not draft and flag false", () => {
  const order = draftOrder({ status: "completed", is_draft_order: false });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "not_draft_order" }]);
});

test("code_not_found when promotion missing", () => {
  const result = classifyPromoRejection(draftOrder(), [], ["MISSING10"]);
  assert.deepEqual(result, [{ code: "MISSING10", reason: "code_not_found" }]);
});

test("code_not_active when promotion status draft", () => {
  const result = classifyPromoRejection(draftOrder(), [promo({ status: "draft" })], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "code_not_active" }]);
});

test("multiple codes classified independently", () => {
  const order = draftOrder();
  const promotions = [promo({ code: "SAVE10", status: "active" }), promo({ code: "OFF20", status: "draft" })];
  const result = classifyPromoRejection(order, promotions, ["SAVE10", "OFF20", "MISSING"]);
  assert.deepEqual(result, [
    { code: "SAVE10", reason: "ok" },
    { code: "OFF20", reason: "code_not_active" },
    { code: "MISSING", reason: "code_not_found" },
  ]);
});

test("no_active_edit_session checked before code lookup", () => {
  const order = draftOrder({ order_change: null });
  const result = classifyPromoRejection(order, [], ["ANY"]);
  assert.deepEqual(result, [{ code: "ANY", reason: "no_active_edit_session" }]);
});

test("not_draft_order takes priority over missing order_change", () => {
  const order = draftOrder({ status: "completed", is_draft_order: false, order_change: null });
  const result = classifyPromoRejection(order, [promo()], ["SAVE10"]);
  assert.deepEqual(result, [{ code: "SAVE10", reason: "not_draft_order" }]);
});
