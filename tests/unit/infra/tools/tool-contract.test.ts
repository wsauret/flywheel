import { describe, it, expect } from "bun:test";
import { defaultDetailFromInput } from "../../../../src/infra/tools/build-display.js";
import { getToolDisplay, getToolDisplayName } from "../../../../src/infra/tools/tool-display-registry.js";

describe("defaultDetailFromInput", () => {
  it("returns input.subject when present", () => {
    expect(defaultDetailFromInput({ subject: "the subject", other: "other" })).toBe("the subject");
  });

  it("returns input.description when subject is absent", () => {
    expect(defaultDetailFromInput({ description: "desc", other: "other" })).toBe("desc");
  });

  it("returns first non-empty string value when no subject/description", () => {
    expect(defaultDetailFromInput({ count: 5, name: "hello" })).toBe("hello");
  });

  it("returns null for empty input", () => {
    expect(defaultDetailFromInput({})).toBeNull();
  });

  it("skips empty strings", () => {
    expect(defaultDetailFromInput({ subject: "", description: "", name: "fallback" })).toBe("fallback");
  });
});

describe("registry", () => {
  it("getToolDisplay normalizes via canonicalize", () => {
    const display = getToolDisplay("READ");
    expect(display.displayName).toBe("Read");
  });

  it("getToolDisplayName handles handoff path for write/edit", () => {
    const handoffPath = "/project/.flywheel/sessions/abc-123/worker_1.json";
    expect(getToolDisplayName("Write", { path: handoffPath })).toBe("Write Handoff");
    expect(getToolDisplayName("Edit", { path: handoffPath })).toBe("Write Handoff");
  });


});
