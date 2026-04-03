import { describe, expect, it } from "bun:test";
import { getCompletionChecklist } from "../../src/harness/verification.js";

describe("getCompletionChecklist", () => {
  const sampleHandoff = {
    summary: "Implemented the hello world endpoint with tests.",
    artifacts: { files_created: ["src/hello.ts"] },
    verification: { tests_passed: true, test_output_summary: "All 5 tests passed." },
  };

  it("includes all four perspectives", () => {
    const checklist = getCompletionChecklist(sampleHandoff);

    expect(checklist).toContain("Test Engineer");
    expect(checklist).toContain("QA Engineer");
    expect(checklist).toContain("User");
    expect(checklist).toContain("Flywheel");
  });

  it("includes the Flywheel-specific perspective about handoff schema", () => {
    const checklist = getCompletionChecklist(sampleHandoff);

    expect(checklist).toContain("handoff JSON");
    expect(checklist).toContain("schema");
    expect(checklist).toContain("required fields");
  });

  it("includes a finality statement asking for confirmation", () => {
    const checklist = getCompletionChecklist(sampleHandoff);

    expect(checklist).toContain("task_complete");
    expect(checklist).toContain("confirm");
  });

  it("includes a preview of the handoff data", () => {
    const checklist = getCompletionChecklist(sampleHandoff);

    expect(checklist).toContain("Implemented the hello world endpoint");
    expect(checklist).toContain("src/hello.ts");
  });

  it("truncates very large handoff previews", () => {
    const largeHandoff = {
      summary: "x".repeat(1000),
      artifacts: { files_created: ["a".repeat(500)] },
    };
    const checklist = getCompletionChecklist(largeHandoff);

    // The JSON preview is limited to 500 chars, so the full content
    // should not appear in its entirety
    const jsonStr = JSON.stringify(largeHandoff, null, 2);
    expect(checklist.length).toBeLessThan(jsonStr.length + 1000);
  });
});
