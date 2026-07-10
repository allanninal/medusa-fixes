import { test } from "node:test";
import assert from "node:assert/strict";
import { findIncompleteVariants } from "./find-variant-options-mismatch.js";

const product = (over = {}) => ({
  id: "prod_1",
  options: [
    { title: "Color", values: [{ value: "Red" }, { value: "Blue" }] },
    { title: "Size", values: [{ value: "S" }, { value: "M" }] },
  ],
  variants: [],
  ...over,
});

const variant = (over = {}) => ({
  id: "variant_1",
  title: "Red / S",
  options: { Color: "Red", Size: "S" },
  ...over,
});

test("complete variant is not flagged", () => {
  const p = product({ variants: [variant()] });
  assert.deepEqual(findIncompleteVariants(p), []);
});

test("missing title is flagged", () => {
  const v = variant({ options: { Color: "Red" } });
  const result = findIncompleteVariants(product({ variants: [v] }));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].missing_titles, ["Size"]);
  assert.deepEqual(result[0].extra_titles, []);
  assert.deepEqual(result[0].invalid_values, []);
});

test("extra title is flagged", () => {
  const v = variant({ options: { Color: "Red", Size: "S", Material: "Cotton" } });
  const result = findIncompleteVariants(product({ variants: [v] }));
  assert.deepEqual(result[0].extra_titles, ["Material"]);
});

test("invalid value is flagged", () => {
  const v = variant({ options: { Color: "Green", Size: "S" } });
  const result = findIncompleteVariants(product({ variants: [v] }));
  assert.deepEqual(result[0].invalid_values, [{ title: "Color", value: "Green" }]);
});

test("multiple variants only flags the bad one", () => {
  const good = variant({ id: "variant_ok", options: { Color: "Blue", Size: "M" } });
  const bad = variant({ id: "variant_bad", options: { Color: "Red" } });
  const result = findIncompleteVariants(product({ variants: [good, bad] }));
  assert.equal(result.length, 1);
  assert.equal(result[0].variant_id, "variant_bad");
});

test("normalizes the expanded admin shape via findIncompleteVariants", () => {
  const v = {
    id: "variant_4",
    title: "Green / L",
    options: [
      { option: { title: "Color" }, value: "Green" },
      { option: { title: "Size" }, value: "L" },
    ],
  };
  const result = findIncompleteVariants(product({ variants: [v] }));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].invalid_values.map((iv) => iv.title).sort(), ["Color", "Size"]);
});

test("product with no variants reports nothing", () => {
  assert.deepEqual(findIncompleteVariants(product({ variants: [] })), []);
});

test("missing and extra titles together", () => {
  const v = variant({ options: { Color: "Red", Material: "Cotton" } });
  const result = findIncompleteVariants(product({ variants: [v] }));
  assert.deepEqual(result[0].missing_titles, ["Size"]);
  assert.deepEqual(result[0].extra_titles, ["Material"]);
});

test("no options on product flags any variant title as extra", () => {
  const p = product({ options: [], variants: [variant({ options: { Color: "Red" } })] });
  const result = findIncompleteVariants(p);
  assert.deepEqual(result[0].missing_titles, []);
  assert.deepEqual(result[0].extra_titles, ["Color"]);
});
