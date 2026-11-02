import { describe, it, expect } from "bun:test";
import { isHandoffPath } from "../../../../src/infra/paths";
import type { ToolInput } from "../../../../src/infra/tools/detail-helpers";
import { getToolDisplay } from "../../../../src/infra/tools/tool-display-registry";

/**
 * Output Blocks rendering logic tests — handoff path detection,
 * ToolDisplay contract registry (getDetail), and rendersAsAgentBlock regression.
 */

// ── Handoff path detection ──

describe("isHandoffPath", () => {
  it("matches a custom-named handoff payload (e.g. plan.json) under the session directory", () => {
    expect(isHandoffPath("/x/.flywheel/sessions/f6648678-361d-4b22-a9b9-61622531cbf5/plan.json")).toBe(true);
  });

  it("rejects a .flywheel path that is not a JSON file in a session dir", () => {
    expect(isHandoffPath("/project/.flywheel/sessions/abc-123/context.md")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isHandoffPath(undefined)).toBe(false);
  });
});

// ── getDetail regression (via contract registry) ──

describe("getDetail via contract registry", () => {
  const executionCwd = "/home/user/project";

  function unknownToolDetail(input: ToolInput): string | null {
    const display = getToolDisplay("SomeRandom");
    if (display.getDetail === undefined) throw new Error("the unknown-tool fallback has no argument-only detail");
    return display.getDetail(input, executionCwd);
  }

  it("unknown tool falls back to subject", () => {
    expect(unknownToolDetail({ subject: "my subject" })).toBe("my subject");
  });

  it("unknown tool falls back to description", () => {
    expect(unknownToolDetail({ description: "my desc" })).toBe("my desc");
  });

  it("unknown tool falls back to first string value", () => {
    expect(unknownToolDetail({ foo: 42, bar: "hello" })).toBe("hello");
  });

  it("unknown tool returns null when no string values", () => {
    expect(unknownToolDetail({ foo: 42 })).toBeNull();
  });

});

// ── rendersAsAgentBlock regression ──

describe("ToolDisplay.rendersAsAgentBlock", () => {
  it("handles case normalization", () => {
    expect(getToolDisplay("Subagent").rendersAsAgentBlock).toBe(getToolDisplay("subagent").rendersAsAgentBlock);
    expect(getToolDisplay("SUBAGENT").rendersAsAgentBlock).toBe(getToolDisplay("subagent").rendersAsAgentBlock);
  });

});
