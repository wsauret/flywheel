import { expect, it } from "bun:test";
import { authoredGuardrailLimits, compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { inputMapWorkflow, mapSkills } from "./_map-fixtures.js";

it.each([undefined, 7])("refuses oversized launch input before reading any item with attempt limit %s", (max_attempts) => {
  const workflow = {
    ...inputMapWorkflow,
    ...(max_attempts === undefined ? {} : { guardrails: { max_attempts } }),
    provenance: { layer: "session" as const, filePath: "scratch/input.workflow.yaml", id: inputMapWorkflow.id },
  };
  const oversized = Array.from({ length: 12_000 }, (): string => "");
  Object.defineProperty(oversized, 0, { get() { throw new Error("expanded before admission"); } });
  const message = max_attempts === undefined
    ? "The workflow needs 24001 attempts for its worst case, more than the ceiling of 4096."
    : "The workflow queues 24001 attempts, more than its attempt limit of 7.";
  expect(() => compileWorkflowControl(workflow, resolveWorkflowAgents(workflow),
    { skills: mapSkills }, authoredGuardrailLimits(workflow), { items: oversized }))
    .toThrow(`attempt_limit_overrun: ${message}`);
});
