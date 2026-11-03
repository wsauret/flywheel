import { parseSchema } from "../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import { QueueV9Schema, WorkflowRowsSchema } from "../../../../src/workflows/view/schemas.js";

// ---------------------------------------------------------------------------
// Step.model cleanup (T5)
// ---------------------------------------------------------------------------
describe("Step.model cleanup", () => {
  it("the rows schema rejects a model field on a persisted attempt", () => {
    const rows = {
      attempts: [{
        id: "step-1",
        definitionId: "implement",
        briefId: "implement",
        workflowDefinitionId: "plan-implement",
        name: "Implement",
        status: "pending",
        writes: [],
        resumeRevertCount: 0,
        model: "gpt-5.4",
      }],
      cursor: 0,
      status: "idle",
      mutationLog: [],
    };
    expect(() => parseSchema(WorkflowRowsSchema, rows)).toThrow(/Expected no excess property/);
  });

  it("the version 9 queue schema rejects defaultable external tool scoping on persisted steps", () => {
    const queue = {
      steps: [{
        id: "step-1",
        definitionId: "implement",
        contentId: "implement",
        workflowDefinitionId: "plan-implement",
        name: "Implement",
        status: "pending",
        writes: [],
        resumeRevertCount: 0,
        toolScoping: {
          read: true,
          bash: false,
          list: false,
          write: true,
          edit: true,
          subagent: false,
        },
      }],
      cursor: 0,
      status: "idle",
      mutationLog: [],
    };
    expect(() => parseSchema(QueueV9Schema, queue)).toThrow(/search/);
  });
});
