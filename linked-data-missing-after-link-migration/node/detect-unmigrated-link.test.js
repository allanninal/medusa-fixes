import { test } from "node:test";
import assert from "node:assert/strict";
import { detectUnmigratedLink, hasLinkedField, countLinkedFieldPresent } from "./detect-unmigrated-link.js";

test("no link defined wins over everything else", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 10, parentsWithLinkedFieldPresent: 0, linkedModuleHasAnyRecords: true, linkDefinitionExistsInCode: false }),
    "NO_LINK_DEFINED",
  );
});

test("OK when no parent records at all", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 0, parentsWithLinkedFieldPresent: 0, linkedModuleHasAnyRecords: true, linkDefinitionExistsInCode: true }),
    "OK",
  );
});

test("likely unmigrated when all empty but linked module has rows", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 50, parentsWithLinkedFieldPresent: 0, linkedModuleHasAnyRecords: true, linkDefinitionExistsInCode: true }),
    "LIKELY_UNMIGRATED_LINK",
  );
});

test("link not yet populated when linked module is also empty", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 50, parentsWithLinkedFieldPresent: 0, linkedModuleHasAnyRecords: false, linkDefinitionExistsInCode: true }),
    "LINK_NOT_YET_POPULATED",
  );
});

test("OK when at least one parent resolved the relation", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 50, parentsWithLinkedFieldPresent: 1, linkedModuleHasAnyRecords: true, linkDefinitionExistsInCode: true }),
    "OK",
  );
});

test("OK when every parent resolved the relation", () => {
  assert.equal(
    detectUnmigratedLink({ totalParentRecords: 50, parentsWithLinkedFieldPresent: 50, linkedModuleHasAnyRecords: true, linkDefinitionExistsInCode: true }),
    "OK",
  );
});

test("hasLinkedField treats null and undefined brand as absent", () => {
  assert.equal(hasLinkedField({ brand: null }), false);
  assert.equal(hasLinkedField({}), false);
});

test("hasLinkedField treats empty array as absent, non-empty array as present", () => {
  assert.equal(hasLinkedField({ brand: [] }), false);
  assert.equal(hasLinkedField({ brand: [{ id: "brand_1" }] }), true);
});

test("hasLinkedField treats a plain object brand as present", () => {
  assert.equal(hasLinkedField({ brand: { id: "brand_1" } }), true);
});

test("countLinkedFieldPresent counts only products with a resolved brand", () => {
  const products = [{ brand: { id: "brand_1" } }, { brand: null }, { brand: [] }, { brand: [{ id: "brand_2" }] }];
  assert.equal(countLinkedFieldPresent(products), 2);
});
