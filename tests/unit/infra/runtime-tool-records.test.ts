import { describe, expect, it } from "bun:test";
import { extractToolResultRecords } from "../../../src/infra/runtime-tool-records.js";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";

describe("extractToolResultRecords", () => {
  it("prefers the emitted outcome field over the wire error flag", () => {
    const event = createRuntimeEvent("tool.result.recorded", {
      tool_use_id: "toolu_h",
      content: [{ type: "text", text: "handoff blocked" }],
      is_error: true,
      outcome: "blocked",
    });
    expect(extractToolResultRecords(event)[0]?.outcome).toBe("blocked");
  });

  it("falls back to is_error/interrupted for external SDK-shaped events without outcome", () => {
    const errored = createRuntimeEvent("tool.result.recorded", {
      tool_use_id: "toolu_a",
      content: [{ type: "text", text: "boom" }],
      is_error: true,
    });
    expect(extractToolResultRecords(errored)[0]?.outcome).toBe("error");

    const ok = createRuntimeEvent("tool.result.recorded", {
      tool_use_id: "toolu_b",
      content: [{ type: "text", text: "done" }],
    });
    expect(extractToolResultRecords(ok)[0]?.outcome).toBe("ok");
  });
});
