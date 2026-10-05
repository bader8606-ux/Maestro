import assert from "node:assert/strict";
import { test } from "node:test";
import { packageSchema } from "../supabase/functions/maestro-api/validation.mjs";

test("Cloud package schema accepts optional SAR catalogue prices and rejects invalid amounts", () => {
  const input = { name: "Catalogue validation fixture", benefits: [] };
  assert.deepEqual(packageSchema.parse(input), input);
  for (const referenceValue of [0, 0.01, 125000.25, 9999999999]) {
    assert.equal(
      packageSchema.parse({ ...input, referenceValue }).referenceValue,
      referenceValue,
    );
  }
  for (const referenceValue of [
    -0.01,
    0.001,
    10000000000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "125000",
    null,
  ]) {
    assert.equal(
      packageSchema.safeParse({ ...input, referenceValue }).success,
      false,
      `Rejects invalid SAR reference value ${String(referenceValue)}`,
    );
  }
});
