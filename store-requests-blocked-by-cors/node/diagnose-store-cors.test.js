import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseCorsGap } from "./diagnose-store-cors.js";

test("missing publishable key wins over everything", () => {
  const result = diagnoseCorsGap(["https://shop.example.com"], "https://shop.example.com", false);
  assert.equal(result.verdict, "NOT_CORS_PAK_ISSUE");
});

test("exact match is OK", () => {
  const result = diagnoseCorsGap(["https://shop.example.com"], "https://shop.example.com", true);
  assert.equal(result.verdict, "OK");
});

test("scheme mismatch is reported", () => {
  const result = diagnoseCorsGap(["http://shop.example.com"], "https://shop.example.com", true);
  assert.equal(result.verdict, "CORS_MISMATCH");
  assert.match(result.reason, /https/);
  assert.match(result.reason, /http/);
});

test("www variant not configured is mismatch", () => {
  const result = diagnoseCorsGap(["https://shop.example.com"], "https://www.shop.example.com", true);
  assert.equal(result.verdict, "CORS_MISMATCH");
});

test("trailing slash is ignored in normalization", () => {
  const result = diagnoseCorsGap(["https://shop.example.com/"], "https://shop.example.com", true);
  assert.equal(result.verdict, "OK");
});

test("case is ignored in scheme and host", () => {
  const result = diagnoseCorsGap(["HTTPS://Shop.Example.com"], "https://shop.example.com", true);
  assert.equal(result.verdict, "OK");
});

test("completely unknown host is mismatch", () => {
  const result = diagnoseCorsGap(["https://shop.example.com"], "https://other-store.example.com", true);
  assert.equal(result.verdict, "CORS_MISMATCH");
  assert.match(result.reason, /no matching host/);
});

test("port mismatch is reported", () => {
  const result = diagnoseCorsGap(["http://localhost:8000"], "http://localhost:3000", true);
  assert.equal(result.verdict, "CORS_MISMATCH");
});

test("multiple configured origins matches correct one", () => {
  const configured = ["https://shop.example.com", "http://localhost:8000"];
  const result = diagnoseCorsGap(configured, "http://localhost:8000", true);
  assert.equal(result.verdict, "OK");
});
