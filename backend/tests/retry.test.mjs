import assert from "node:assert/strict";
import test from "node:test";
import { withBoundedRetry } from "../dist/src/utils/retry.js";

test("retries a failed operation and eventually returns its result", async () => {
  let attempts = 0;

  const result = await withBoundedRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("temporary failure");
      return "ok";
    },
    { maxAttempts: 2, baseDelayMs: 0 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("stops after the configured number of attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    withBoundedRetry(
      async () => {
        attempts += 1;
        throw new Error("still unavailable");
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    ),
    /still unavailable/,
  );

  assert.equal(attempts, 3);
});
