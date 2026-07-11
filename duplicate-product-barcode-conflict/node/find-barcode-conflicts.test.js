import { test } from "node:test";
import assert from "node:assert/strict";
import { findBarcodeConflicts } from "./find-barcode-conflicts.js";

const variant = (over = {}) => ({
  productId: "prod_1",
  variantId: "variant_1",
  barcode: null,
  ean: null,
  upc: null,
  ...over,
});

test("no conflicts returns empty list", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", barcode: "1111" }),
    variant({ productId: "prod_2", variantId: "variant_2", barcode: "2222" }),
  ];
  assert.deepEqual(findBarcodeConflicts(variants), []);
});

test("two products sharing a barcode is flagged", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", barcode: "1111" }),
    variant({ productId: "prod_2", variantId: "variant_2", barcode: "1111" }),
  ];
  const conflicts = findBarcodeConflicts(variants);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "barcode");
  assert.equal(conflicts[0].value, "1111");
  assert.equal(conflicts[0].entries.length, 2);
});

test("same product repeat is not flagged", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", barcode: "1111" }),
    variant({ productId: "prod_1", variantId: "variant_2", barcode: "1111" }),
  ];
  assert.deepEqual(findBarcodeConflicts(variants), []);
});

test("fields are checked independently", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", ean: "9999" }),
    variant({ productId: "prod_2", variantId: "variant_2", upc: "9999" }),
  ];
  assert.deepEqual(findBarcodeConflicts(variants), []);
});

test("blank and null values are ignored", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", barcode: "" }),
    variant({ productId: "prod_2", variantId: "variant_2", barcode: null }),
  ];
  assert.deepEqual(findBarcodeConflicts(variants), []);
});

test("conflicts are sorted by field then value", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", upc: "500" }),
    variant({ productId: "prod_2", variantId: "variant_2", upc: "500" }),
    variant({ productId: "prod_3", variantId: "variant_3", barcode: "100" }),
    variant({ productId: "prod_4", variantId: "variant_4", barcode: "100" }),
  ];
  const conflicts = findBarcodeConflicts(variants);
  assert.deepEqual(conflicts.map((c) => c.field), ["barcode", "upc"]);
});

test("three way collision reports all three entries", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", ean: "7777" }),
    variant({ productId: "prod_2", variantId: "variant_2", ean: "7777" }),
    variant({ productId: "prod_3", variantId: "variant_3", ean: "7777" }),
  ];
  const conflicts = findBarcodeConflicts(variants);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entries.length, 3);
});

test("same product and cross product repeats do not double count", () => {
  const variants = [
    variant({ productId: "prod_1", variantId: "variant_1", barcode: "1111" }),
    variant({ productId: "prod_1", variantId: "variant_2", barcode: "1111" }),
    variant({ productId: "prod_2", variantId: "variant_3", barcode: "1111" }),
  ];
  const conflicts = findBarcodeConflicts(variants);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entries.length, 3);
});
