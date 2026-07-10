import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApiKeyRepair } from "./link-publishable-key.js";

const apiKey = (over = {}) => ({ id: "pk_1", revoked_at: null, sales_channels: [], ...over });

test("revoked key is left alone", () => {
  const result = decideApiKeyRepair(apiKey({ revoked_at: "2026-01-01T00:00:00Z" }), "sc_default");
  assert.deepEqual(result, { action: "none", reason: "key revoked" });
});

test("revoked takes priority over empty channels", () => {
  const result = decideApiKeyRepair(apiKey({ revoked_at: "2026-01-01T00:00:00Z", sales_channels: [] }), "sc_default");
  assert.deepEqual(result, { action: "none", reason: "key revoked" });
});

test("key with active link is left alone", () => {
  const result = decideApiKeyRepair(apiKey({ sales_channels: [{ id: "sc_1", is_disabled: false }] }), "sc_default");
  assert.deepEqual(result, { action: "none", reason: "already linked to an active sales channel" });
});

test("key with mixed disabled and enabled links is left alone", () => {
  const result = decideApiKeyRepair(
    apiKey({ sales_channels: [{ id: "sc_1", is_disabled: true }, { id: "sc_2", is_disabled: false }] }),
    "sc_default",
  );
  assert.deepEqual(result, { action: "none", reason: "already linked to an active sales channel" });
});

test("key with only disabled links and no default is flagged", () => {
  const result = decideApiKeyRepair(apiKey({ sales_channels: [{ id: "sc_1", is_disabled: true }] }), null);
  assert.deepEqual(result, { action: "flag", reason: "no sales channel linked and no unambiguous default to link" });
});

test("key with zero links and no default is flagged", () => {
  const result = decideApiKeyRepair(apiKey({ sales_channels: [] }), null);
  assert.deepEqual(result, { action: "flag", reason: "no sales channel linked and no unambiguous default to link" });
});

test("key with zero active links and a default is linked", () => {
  const result = decideApiKeyRepair(apiKey({ sales_channels: [{ id: "sc_1", is_disabled: true }] }), "sc_default");
  assert.deepEqual(result, {
    action: "link",
    reason: "key has zero active sales-channel links",
    salesChannelIdToAdd: "sc_default",
  });
});

test("key with no sales channels at all and a default is linked", () => {
  const result = decideApiKeyRepair(apiKey({ sales_channels: [] }), "sc_default");
  assert.deepEqual(result, {
    action: "link",
    reason: "key has zero active sales-channel links",
    salesChannelIdToAdd: "sc_default",
  });
});
