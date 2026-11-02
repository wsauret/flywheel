import { expect, test } from "bun:test";
import { startProbeLeaseRenewal } from "../../../../../src/orchestration/agent-runtime/llm/probe-lease-renewal.js";

test("a transient renewal failure does not stop later lease renewals", async () => {
  let calls = 0;
  let failures = 0;
  const stop = startProbeLeaseRenewal({
    intervalMs: 1,
    isStopped: () => false,
    renew: () => {
      calls += 1;
      if (calls === 1) throw new Error("SQLITE_BUSY");
      return calls < 3;
    },
    onFailure: () => { failures += 1 },
  });

  // Poll to the condition: a fixed sleep starves under parallel-shard CPU
  // contention, where 1ms timers land far apart.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (calls >= 3) break;
    await Bun.sleep(2);
  }
  stop();

  expect(failures).toBe(1);
  expect(calls).toBeGreaterThanOrEqual(3);
});
