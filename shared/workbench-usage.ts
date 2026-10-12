import type { WorkbenchJob } from "./workbench";

/** Native cumulative per-worker totals; never interpret these as account percentages. */
export function workbenchUsage(job: WorkbenchJob) {
  const workers = [
    ...(job.externalExecution?.workerHistory ?? []),
    ...(job.externalExecution?.worker ? [job.externalExecution.worker] : []),
  ];
  let measured = 0,
    missing = 0,
    local = 0,
    input = 0,
    cached = 0,
    output = 0,
    total = 0;
  for (const worker of workers) {
    if (!worker) {
      missing++;
      continue;
    }
    if (worker.localOnly) {
      local++;
      continue;
    }
    const usage = worker.usage as
      | {
          total?: {
            inputTokens?: number;
            cachedInputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
        }
      | undefined;
    const v = usage?.total;
    if (
      !v ||
      ![
        v.inputTokens,
        v.cachedInputTokens,
        v.outputTokens,
        v.totalTokens,
      ].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      ) ||
      v.cachedInputTokens! > v.inputTokens!
    ) {
      missing++;
      continue;
    }
    measured++;
    input += v.inputTokens!;
    cached += v.cachedInputTokens!;
    output += v.outputTokens!;
    total += v.totalTokens!;
  }
  return {
    measured,
    missing,
    local,
    input,
    cached,
    uncached: input - cached,
    output,
    total,
  };
}
