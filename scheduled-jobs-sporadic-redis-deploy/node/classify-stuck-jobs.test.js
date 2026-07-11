import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyJob } from "./classify-stuck-jobs.js";

const NOW = 1_800_000_000_000;
const STEP_TIMEOUT_MS = 60_000;

const job = (over = {}) => ({
  id: "job-transaction-sync-job",
  timestamp: NOW - 1_000,
  processedOn: undefined,
  finishedOn: undefined,
  failedReason: undefined,
  attemptsMade: 0,
  opts: { attempts: 3 },
  ...over,
});

test("healthy when freshly queued", () => {
  assert.equal(classifyJob(job(), NOW, STEP_TIMEOUT_MS), "healthy");
});

test("orphaned-not-found from failedReason", () => {
  const j = job({ failedReason: 'Error: Workflow with id "job-transaction-sync-job" not found' });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "orphaned-not-found");
});

test("stuck-active when processed but not finished past timeout", () => {
  const j = job({ processedOn: NOW - STEP_TIMEOUT_MS - 1 });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "stuck-active");
});

test("not stuck-active when within timeout", () => {
  const j = job({ processedOn: NOW - 1_000 });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "healthy");
});

test("exhausted-retries when attempts used up", () => {
  const j = job({ attemptsMade: 3, opts: { attempts: 3 }, failedReason: "boom" });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "exhausted-retries");
});

test("not exhausted when finished even if attempts high", () => {
  const j = job({ attemptsMade: 3, opts: { attempts: 3 }, failedReason: "boom", finishedOn: NOW });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "healthy");
});

test("pending-too-long when never processed", () => {
  const j = job({ timestamp: NOW - STEP_TIMEOUT_MS - 1 });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "pending-too-long");
});

test("not-found takes priority over other signals", () => {
  const j = job({
    failedReason: 'Workflow with id "x" not found',
    processedOn: NOW - STEP_TIMEOUT_MS - 1,
    attemptsMade: 3,
    opts: { attempts: 3 },
  });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "orphaned-not-found");
});

test("exactly at timeout is not yet stuck", () => {
  const j = job({ processedOn: NOW - STEP_TIMEOUT_MS });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "healthy");
});

test("missing attempts option defaults to one", () => {
  const j = job({ attemptsMade: 1, opts: {}, failedReason: "boom" });
  assert.equal(classifyJob(j, NOW, STEP_TIMEOUT_MS), "exhausted-retries");
});
