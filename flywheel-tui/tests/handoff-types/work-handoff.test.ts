import { describe, it, expect } from "bun:test";
import {
  getHandoffType,
  getAllHandoffTypes,
} from "../../src/workflows/handoff-types/registry.js";
import "../../src/workflows/handoff-types/register-all.js";
import { WorkerHandoffSchema } from "../../src/infra/handoff-schemas.js";
import { WORK_STEP_FIELDS } from "../../src/workflows/queue/steps/work/fields.js";
import {
  VALID_FULL_HANDOFF,
  VALID_MINIMAL_HANDOFF,
} from "../fixtures/worker-handoff-fixtures";

describe("work-handoff registration", () => {
  it("getHandoffType('work-handoff') returns the registered type with the exact schema reference", () => {
    const entry = getHandoffType("work-handoff");
    expect(entry).toBeDefined();
    expect(entry?.schema).toBe(WorkerHandoffSchema);
  });

  it("fields reference is WORK_STEP_FIELDS by identity", () => {
    const entry = getHandoffType("work-handoff");
    expect(entry?.fields).toBe(WORK_STEP_FIELDS);
  });

  it("description is a non-empty string", () => {
    const entry = getHandoffType("work-handoff");
    expect(typeof entry?.description).toBe("string");
    expect((entry?.description ?? "").length).toBeGreaterThan(0);
  });

  it("schema accepts the validFull handoff fixture", () => {
    const entry = getHandoffType("work-handoff");
    const result = entry!.schema.safeParse(VALID_FULL_HANDOFF);
    expect(result.success).toBe(true);
  });

  it("schema accepts the validMinimal handoff fixture", () => {
    const entry = getHandoffType("work-handoff");
    const result = entry!.schema.safeParse(VALID_MINIMAL_HANDOFF);
    expect(result.success).toBe(true);
  });

  it("schema preserves the superRefine cross-field rule (tests_passed=true + short test_output_summary fails)", () => {
    const entry = getHandoffType("work-handoff");
    const bad = {
      summary: "Ran the suite and verified the output. One sentence summary.",
      verification: {
        tests_passed: true,
        test_output_summary: "short",
      },
    };
    const result = entry!.schema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const tosError = result.error.issues.find(
        (i) => i.path.join(".") === "verification.test_output_summary",
      );
      expect(tosError).toBeDefined();
      expect(tosError?.message).toContain("10");
    }
  });

  it("non-registered handoff-type names return undefined (evaluator-handoff, dispatcher-handoff)", () => {
    expect(getHandoffType("evaluator-handoff")).toBeUndefined();
    expect(getHandoffType("dispatcher-handoff")).toBeUndefined();
  });

  it("getAllHandoffTypes contains work-handoff exactly once", () => {
    // Tests share a Bun process where synthetic handoff types may be
    // registered by other test files (e.g. registry.test.ts), so we do
    // not assert absolute cardinality. The filter-based check pins
    // exactly-once for work-handoff specifically.
    const names = getAllHandoffTypes().map((t) => t.name);
    expect(names.filter((n) => n === "work-handoff")).toHaveLength(1);
  });
});
