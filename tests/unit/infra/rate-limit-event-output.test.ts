import { describe, expect, test } from "bun:test";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";
import { RuntimeEventProjector } from "../../../src/infra/output/runtime-event-projector.js";
import { OutputProjector } from "../../../src/infra/output/output-projector.js";

describe("rate limit event output", () => {
  test("projects provider rate limit warnings as system messages", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" });
    const parser = new RuntimeEventProjector(projector);

    parser.dispatch(createRuntimeEvent("agent.rate_limit.observed", {
      type: "agent.rate_limit.observed",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 1,
        surpassedThreshold: 0.9,
        resetsAt: 1778922000,
      },
    }), 1000);

    const blocks = projector.getBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("system");
    const block = blocks[0];
    if (block?.kind !== "system") throw new Error("expected system block");
    expect(block.level).toBe("info");
    expect(block.message).toContain("Provider rate limit warning");
    expect(block.message).toContain("five_hour");
    expect(block.message).toContain("100% used");
    expect(block.message).toContain("warning threshold 90%");
    expect(block.message).toContain("status allowed_warning");
  });
});
