import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImageHealth } from "./find-broken-images.js";

const HOSTS = ["cdn.example.com", "my-bucket.s3.amazonaws.com"];

test("ok when status 200 on configured host", () => {
  const check = { url: "https://cdn.example.com/shirt.jpg", status: 200, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "ok");
});

test("unreachable on 404 same host", () => {
  const check = { url: "https://cdn.example.com/gone.jpg", status: 404, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "unreachable");
});

test("unreachable on network error", () => {
  const check = { url: "https://cdn.example.com/timeout.jpg", status: null, error: "timed out", configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "unreachable");
});

test("unreachable on 5xx", () => {
  const check = { url: "https://cdn.example.com/oops.jpg", status: 503, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "unreachable");
});

test("foreign host even when 200", () => {
  const check = { url: "http://localhost:9000/uploads/old.jpg", status: 200, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "foreign_host");
});

test("malformed url string", () => {
  const check = { url: "not-a-url", status: null, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "malformed");
});

test("malformed wins over status", () => {
  const check = { url: "", status: 200, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "malformed");
});

test("foreign host check is case insensitive", () => {
  const check = { url: "https://CDN.example.com/shirt.jpg", status: 200, error: null, configuredHosts: HOSTS };
  assert.equal(classifyImageHealth(check).state, "ok");
});
