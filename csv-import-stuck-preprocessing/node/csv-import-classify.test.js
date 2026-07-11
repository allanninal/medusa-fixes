import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImportJob } from "./flag-stuck-import.js";

const NOW = new Date("2026-07-10T00:20:00Z");

const job = (over = {}) => ({
  transactionId: "tx_01",
  createdAt: new Date("2026-07-10T00:00:00Z"),
  workflowState: "waiting",
  lastEventAt: null,
  ...over,
});

test("stuck when waiting past timeout with no event", () => {
  const result = classifyImportJob(job(), NOW, 10 * 60000);
  assert.equal(result.status, "stuck");
  assert.equal(result.minutesStuck, 20);
});

test("ok when within timeout", () => {
  const result = classifyImportJob(job(), NOW, 30 * 60000);
  assert.equal(result.status, "ok");
});

test("completed when state is done", () => {
  const result = classifyImportJob(job({ workflowState: "done" }), NOW, 1);
  assert.equal(result.status, "completed");
});

test("failed when state is failed", () => {
  const result = classifyImportJob(job({ workflowState: "failed" }), NOW, 1);
  assert.equal(result.status, "failed");
});

test("failed when state is reverted", () => {
  const result = classifyImportJob(job({ workflowState: "reverted" }), NOW, 1);
  assert.equal(result.status, "failed");
});

test("ok when past timeout but event seen", () => {
  const seen = new Date("2026-07-10T00:05:00Z");
  const result = classifyImportJob(job({ lastEventAt: seen }), NOW, 10 * 60000);
  assert.equal(result.status, "ok");
});

test("invoking state also evaluated for stuck", () => {
  const result = classifyImportJob(job({ workflowState: "invoking" }), NOW, 10 * 60000);
  assert.equal(result.status, "stuck");
});
