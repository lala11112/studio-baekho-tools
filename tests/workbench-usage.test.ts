import { test } from "node:test";
import assert from "node:assert/strict";
import { workbenchUsage } from "../shared/workbench-usage";
test("usage includes failed attempts, marks missing telemetry and distinguishes local work", () => {
  const usage = {
    total: {
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 5,
      totalTokens: 105,
    },
  };
  const result = workbenchUsage({
    externalExecution: {
      workerHistory: [
        { attempt: 1, usage },
        { attempt: 2 },
        { attempt: 3, localOnly: true },
      ],
      worker: { attempt: 4, usage },
    },
  } as any);
  assert.deepEqual(result, {
    measured: 2,
    missing: 1,
    local: 1,
    input: 200,
    cached: 160,
    uncached: 40,
    output: 10,
    total: 210,
  });
  assert.equal(
    workbenchUsage({
      externalExecution: {
        worker: {
          usage: {
            total: {
              inputTokens: 1,
              cachedInputTokens: 2,
              outputTokens: 0,
              totalTokens: 1,
            },
          },
        },
      },
    } as any).missing,
    1,
  );
});
