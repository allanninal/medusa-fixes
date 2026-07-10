import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublishableKeyFix } from "./fix-publishable-key-sales-channel.js";

const key = (over = {}) => ({
  id: "pk_1",
  revoked_at: null,
  sales_channels: [{ id: "sc_1", is_disabled: false }],
  ...over,
});

test("revoked key is flagged", () => {
  const result = decidePublishableKeyFix(key({ revoked_at: "2026-01-01T00:00:00Z" }), { sc_1: 5 });
  assert.deepEqual(result, { status: "revoked", action: "flag" });
});

test("no sales channels is linked", () => {
  const result = decidePublishableKeyFix(key({ sales_channels: [] }), {});
  assert.deepEqual(result, { status: "no_sales_channels", action: "link_default_channel" });
});

test("all channels disabled is flagged", () => {
  const result = decidePublishableKeyFix(
    key({ sales_channels: [{ id: "sc_1", is_disabled: true }, { id: "sc_2", is_disabled: true }] }),
    { sc_1: 5, sc_2: 3 }
  );
  assert.deepEqual(result, { status: "channels_disabled", action: "flag" });
});

test("mixed disabled and enabled is not channels_disabled", () => {
  const result = decidePublishableKeyFix(
    key({ sales_channels: [{ id: "sc_1", is_disabled: true }, { id: "sc_2", is_disabled: false }] }),
    { sc_1: 0, sc_2: 5 }
  );
  assert.deepEqual(result, { status: "ok", action: "none" });
});

test("all channels have zero products is flagged", () => {
  const result = decidePublishableKeyFix(key(), { sc_1: 0 });
  assert.deepEqual(result, { status: "channels_empty", action: "flag" });
});

test("missing product count entry counts as zero", () => {
  const result = decidePublishableKeyFix(key(), {});
  assert.deepEqual(result, { status: "channels_empty", action: "flag" });
});

test("healthy key is ok", () => {
  const result = decidePublishableKeyFix(key(), { sc_1: 12 });
  assert.deepEqual(result, { status: "ok", action: "none" });
});

test("revoked takes priority over empty channels", () => {
  const result = decidePublishableKeyFix(key({ revoked_at: "2026-01-01T00:00:00Z", sales_channels: [] }), {});
  assert.deepEqual(result, { status: "revoked", action: "flag" });
});

test("one channel with products among many empty is ok", () => {
  const result = decidePublishableKeyFix(
    key({ sales_channels: [{ id: "sc_1", is_disabled: false }, { id: "sc_2", is_disabled: false }] }),
    { sc_1: 0, sc_2: 4 }
  );
  assert.deepEqual(result, { status: "ok", action: "none" });
});
