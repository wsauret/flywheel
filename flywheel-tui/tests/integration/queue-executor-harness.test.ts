import { describe, expect, test, afterEach } from "bun:test";
import { createHarness, resetStepCounter, type Harness } from "./queue-executor-harness";

describe("queue-executor-harness smoke test", () => {
  let harness: Harness;

  afterEach(() => {
    harness?.cleanup();
    resetStepCounter();
  });

  test("3-step queue runs to completion", async () => {
    harness = createHarness({ stepCount: 3 });
    const result = await harness.executor.run();

    // Assert: run() returns expected result
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsTotal).toBe(3);

    // Assert: all steps have status completed
    for (const step of harness.queue.steps) {
      expect(step.status).toBe("completed");
    }

    // Assert: persisted queue matches in-memory state
    const loaded = await harness.persistence.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.steps).toHaveLength(3);
    for (const step of loaded!.steps) {
      expect(step.status).toBe("completed");
    }
    expect(loaded!.status).toBe("completed");
  });
});
