import { test } from "node:test";
import assert from "node:assert/strict";
import { diffVariantOptionSignatures, normalizeVariants } from "./diff-variant-options.js";

const variant = (sku, size, color) => ({
  sku,
  options: [{ title: "Size", value: size }, { title: "Color", value: color }],
});

test("identical order has no mismatches", () => {
  const source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")];
  const dup = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")];
  assert.deepEqual(diffVariantOptionSignatures(source, dup), []);
});

test("shuffled option order within a variant is not a mismatch", () => {
  const source = [{ sku: "SKU-1", options: [{ title: "Size", value: "Small" }, { title: "Color", value: "Red" }] }];
  const dup = [{ sku: "SKU-1", options: [{ title: "Color", value: "Red" }, { title: "Size", value: "Small" }] }];
  assert.deepEqual(diffVariantOptionSignatures(source, dup), []);
});

test("scrambled value assignment is flagged", () => {
  const source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")];
  const dup = [variant("SKU-1", "Large", "Blue"), variant("SKU-2", "Small", "Red")];
  const mismatches = diffVariantOptionSignatures(source, dup);
  assert.equal(mismatches.length, 2);
  const skus = new Set(mismatches.map((m) => m.sku));
  assert.deepEqual(skus, new Set(["SKU-1", "SKU-2"]));
});

test("mismatch reports expected and actual", () => {
  const source = [variant("SKU-1", "Small", "Red")];
  const dup = [variant("SKU-1", "Large", "Red")];
  const mismatches = diffVariantOptionSignatures(source, dup);
  assert.deepEqual(mismatches, [{ sku: "SKU-1", expected: "Color:Red|Size:Small", actual: "Color:Red|Size:Large" }]);
});

test("collision where two duplicate variants share a signature", () => {
  const source = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Large", "Blue")];
  const dup = [variant("SKU-1", "Small", "Red"), variant("SKU-2", "Small", "Red")];
  const mismatches = diffVariantOptionSignatures(source, dup);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].sku, "SKU-2");
  assert.equal(mismatches[0].actual, "Color:Red|Size:Small");
});

test("falls back to index when skus are missing", () => {
  const source = [
    { sku: null, options: [{ title: "Size", value: "Small" }] },
    { sku: null, options: [{ title: "Size", value: "Large" }] },
  ];
  const dup = [
    { sku: null, options: [{ title: "Size", value: "Large" }] },
    { sku: null, options: [{ title: "Size", value: "Small" }] },
  ];
  const mismatches = diffVariantOptionSignatures(source, dup);
  assert.equal(mismatches.length, 2);
});

test("falls back to index when skus collide", () => {
  const source = [variant("SAME", "Small", "Red"), variant("SAME", "Large", "Blue")];
  const dup = [variant("SAME", "Large", "Blue"), variant("SAME", "Small", "Red")];
  const mismatches = diffVariantOptionSignatures(source, dup);
  assert.equal(mismatches.length, 2);
});

test("no mismatches when products have no variants", () => {
  assert.deepEqual(diffVariantOptionSignatures([], []), []);
});

test("normalizeVariants drops ids and keeps title/value pairs", () => {
  const product = {
    variants: [
      {
        id: "variant_1",
        sku: "SKU-1",
        options: [
          { id: "optval_1", option_id: "opt_1", value: "Small", option: { id: "opt_1", title: "Size" } },
        ],
      },
    ],
  };
  const normalized = normalizeVariants(product);
  assert.deepEqual(normalized, [{ sku: "SKU-1", options: [{ title: "Size", value: "Small" }] }]);
});
