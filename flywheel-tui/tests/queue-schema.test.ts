import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

// Import schemas and types from the modules we're about to create
import {
  StepTypeSchema,
  StepStatusSchema,
  StepSchema,
  QueueStatusSchema,
  MutationLogEntrySchema,
  QueueSchema,
  WorkflowTemplateSchema,
} from "../src/queue/schemas";

import type {
  StepType,
  StepStatus,
  Step,
  QueueStatus,
  MutationLogEntry,
  Queue,
  WorkflowTemplate,
} from "../src/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validStep(overrides: Partial<Step> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    type: "work",
    title: "Implement feature X",
    status: "pending",
    ...overrides,
  };
}

function validQueue(overrides: Partial<Queue> = {}): Record<string, unknown> {
  return {
    steps: [validStep()],
    cursor: 0,
    status: "running",
    mutationLog: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-006: All step types accepted
// ---------------------------------------------------------------------------

describe("StepTypeSchema", () => {
  const VALID_TYPES: StepType[] = [
    "plan",
    "work",
    "review",
    "ship",
    "debug",
    "research",
    "verify",
    "gate",
  ];

  test("accepts all 8 valid step types", () => {
    for (const t of VALID_TYPES) {
      const result = StepTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid step type", () => {
    const result = StepTypeSchema.safeParse("invalid");
    expect(result.success).toBe(false);
  });

  test("rejects empty string", () => {
    const result = StepTypeSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects number", () => {
    const result = StepTypeSchema.safeParse(42);
    expect(result.success).toBe(false);
  });

  test("rejects null", () => {
    const result = StepTypeSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  test("has exactly 8 values", () => {
    // StepTypeSchema is a z.enum — its options should have length 8
    expect(StepTypeSchema.options).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// StepStatusSchema
// ---------------------------------------------------------------------------

describe("StepStatusSchema", () => {
  const VALID_STATUSES: StepStatus[] = [
    "pending",
    "running",
    "completed",
    "failed",
    "skipped",
  ];

  test("accepts all 5 valid step statuses", () => {
    for (const s of VALID_STATUSES) {
      const result = StepStatusSchema.safeParse(s);
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid status", () => {
    const result = StepStatusSchema.safeParse("paused");
    expect(result.success).toBe(false);
  });

  test("has exactly 5 values", () => {
    expect(StepStatusSchema.options).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-007: Step required fields validated
// ---------------------------------------------------------------------------

describe("StepSchema", () => {
  test("parses a valid step with all required fields", () => {
    const step = validStep();
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(step.id);
      expect(result.data.type).toBe("work");
      expect(result.data.title).toBe("Implement feature X");
      expect(result.data.status).toBe("pending");
    }
  });

  test("requires id field", () => {
    const { id, ...noId } = validStep();
    const result = StepSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("requires type field", () => {
    const { type, ...noType } = validStep();
    const result = StepSchema.safeParse(noType);
    expect(result.success).toBe(false);
  });

  test("requires title field", () => {
    const { title, ...noTitle } = validStep();
    const result = StepSchema.safeParse(noTitle);
    expect(result.success).toBe(false);
  });

  test("requires status field", () => {
    const { status, ...noStatus } = validStep();
    const result = StepSchema.safeParse(noStatus);
    expect(result.success).toBe(false);
  });

  test("accepts optional dependsOn array", () => {
    const step = validStep({ dependsOn: ["step-1", "step-2"] });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual(["step-1", "step-2"]);
    }
  });

  test("accepts optional fulfills array", () => {
    const step = validStep({ fulfills: ["VAL-QUEUE-001"] });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fulfills).toEqual(["VAL-QUEUE-001"]);
    }
  });

  test("accepts optional milestone string", () => {
    const step = validStep({ milestone: "core-queue" });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.milestone).toBe("core-queue");
    }
  });

  test("accepts step without optional fields", () => {
    const step = validStep();
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toBeUndefined();
      expect(result.data.fulfills).toBeUndefined();
      expect(result.data.milestone).toBeUndefined();
    }
  });

  test("rejects unknown fields (.strict())", () => {
    const step = { ...validStep(), unknownField: "bad" };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("validates id is a string", () => {
    const step = validStep({ id: 42 as unknown as string });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("validates type against StepType enum", () => {
    const step = validStep({ type: "invalid" as StepType });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("validates status against StepStatus enum", () => {
    const step = validStep({ status: "paused" as StepStatus });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  // VAL-QUEUE-006: each of the 8 types accepted
  test("accepts all 8 step types in a full step", () => {
    const types: StepType[] = [
      "plan", "work", "review", "ship",
      "debug", "research", "verify", "gate",
    ];
    for (const t of types) {
      const step = validStep({ type: t });
      const result = StepSchema.safeParse(step);
      expect(result.success).toBe(true);
    }
  });

  // VAL-QUEUE-006: invalid type rejected
  test("rejects invalid step type in full step", () => {
    const step = validStep({ type: "execute" as StepType });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QueueStatusSchema
// ---------------------------------------------------------------------------

describe("QueueStatusSchema", () => {
  test("accepts 'idle'", () => {
    expect(QueueStatusSchema.safeParse("idle").success).toBe(true);
  });

  test("accepts 'running'", () => {
    expect(QueueStatusSchema.safeParse("running").success).toBe(true);
  });

  test("accepts 'completed'", () => {
    expect(QueueStatusSchema.safeParse("completed").success).toBe(true);
  });

  test("accepts 'failed'", () => {
    expect(QueueStatusSchema.safeParse("failed").success).toBe(true);
  });

  test("accepts 'paused'", () => {
    expect(QueueStatusSchema.safeParse("paused").success).toBe(true);
  });

  test("rejects invalid status", () => {
    expect(QueueStatusSchema.safeParse("stopped").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MutationLogEntrySchema
// ---------------------------------------------------------------------------

describe("MutationLogEntrySchema", () => {
  test("parses a valid mutation log entry", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "insert",
      actor: "executor",
      reason: "Plan output formalization",
      stepIds: [randomUUID()],
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  test("requires timestamp", () => {
    const entry = {
      action: "insert",
      actor: "executor",
      reason: "test",
      stepIds: [],
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  test("requires action", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      actor: "executor",
      reason: "test",
      stepIds: [],
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  test("requires actor", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "insert",
      reason: "test",
      stepIds: [],
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  test("requires reason", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "insert",
      actor: "executor",
      stepIds: [],
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  test("requires stepIds", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "insert",
      actor: "executor",
      reason: "test",
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields (.strict())", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "insert",
      actor: "executor",
      reason: "test",
      stepIds: [],
      extra: "bad",
    };
    const result = MutationLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QueueSchema
// ---------------------------------------------------------------------------

describe("QueueSchema", () => {
  test("parses a valid queue", () => {
    const queue = validQueue();
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(1);
      expect(result.data.cursor).toBe(0);
      expect(result.data.status).toBe("running");
      expect(result.data.mutationLog).toEqual([]);
    }
  });

  test("requires steps array", () => {
    const { steps, ...noSteps } = validQueue();
    const result = QueueSchema.safeParse(noSteps);
    expect(result.success).toBe(false);
  });

  test("requires cursor number", () => {
    const { cursor, ...noCursor } = validQueue();
    const result = QueueSchema.safeParse(noCursor);
    expect(result.success).toBe(false);
  });

  test("requires status", () => {
    const { status, ...noStatus } = validQueue();
    const result = QueueSchema.safeParse(noStatus);
    expect(result.success).toBe(false);
  });

  test("requires mutationLog", () => {
    const { mutationLog, ...noLog } = validQueue();
    const result = QueueSchema.safeParse(noLog);
    expect(result.success).toBe(false);
  });

  test("validates steps are valid Step objects", () => {
    const queue = validQueue({ steps: [{ bad: true }] as unknown as Step[] });
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(false);
  });

  test("accepts queue with multiple steps", () => {
    const steps = [
      validStep({ type: "plan", title: "Plan phase" }),
      validStep({ type: "work", title: "Work phase" }),
      validStep({ type: "review", title: "Review phase" }),
    ];
    const queue = validQueue({ steps: steps as Step[] });
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(3);
    }
  });

  test("accepts queue with empty steps array", () => {
    const queue = validQueue({ steps: [] });
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
  });

  test("validates cursor is a number", () => {
    const queue = validQueue({ cursor: "0" as unknown as number });
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(false);
  });

  test("validates cursor is non-negative integer", () => {
    const negResult = QueueSchema.safeParse(validQueue({ cursor: -1 }));
    expect(negResult.success).toBe(false);
  });

  test("rejects unknown fields (.strict())", () => {
    const queue = { ...validQueue(), extra: "bad" };
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(false);
  });

  test("accepts optional maxSteps field", () => {
    const queue = { ...validQueue(), maxSteps: 50 };
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSteps).toBe(50);
    }
  });

  test("accepts queue without maxSteps (undefined)", () => {
    const queue = validQueue();
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxSteps).toBeUndefined();
    }
  });

  test("rejects maxSteps less than 1", () => {
    const queue = { ...validQueue(), maxSteps: 0 };
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(false);
  });

  test("rejects non-integer maxSteps", () => {
    const queue = { ...validQueue(), maxSteps: 3.5 };
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowTemplateSchema
// ---------------------------------------------------------------------------

describe("WorkflowTemplateSchema", () => {
  test("parses a valid workflow template", () => {
    const template = {
      name: "plan-work-review",
      label: "Plan + Work + Review",
      description: "Plan, execute work steps, then review",
      initialStepTypes: ["plan", "review"],
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(true);
  });

  test("requires name", () => {
    const template = {
      label: "Test",
      description: "Test",
      initialStepTypes: ["plan"],
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  test("requires label", () => {
    const template = {
      name: "test",
      description: "Test",
      initialStepTypes: ["plan"],
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  test("requires description", () => {
    const template = {
      name: "test",
      label: "Test",
      initialStepTypes: ["plan"],
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  test("requires initialStepTypes", () => {
    const template = {
      name: "test",
      label: "Test",
      description: "Test",
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  test("validates initialStepTypes are valid StepTypes", () => {
    const template = {
      name: "test",
      label: "Test",
      description: "Test",
      initialStepTypes: ["invalid"],
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });

  test("rejects unknown fields (.strict())", () => {
    const template = {
      name: "test",
      label: "Test",
      description: "Test",
      initialStepTypes: ["plan"],
      extra: "bad",
    };
    const result = WorkflowTemplateSchema.safeParse(template);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-001: Queue creation from workflow template
// (Type-level test — verifying that a queue created from template data
//  has correct initial steps with pending status and unique IDs)
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-001: Queue from template data", () => {
  test("queue steps have pending status and unique IDs", () => {
    const steps = [
      validStep({ type: "plan", title: "Create plan", status: "pending" }),
      validStep({ type: "work", title: "Execute work", status: "pending" }),
      validStep({ type: "review", title: "Review changes", status: "pending" }),
    ];
    const queue = validQueue({
      steps: steps as Step[],
      cursor: 0,
      status: "running",
      mutationLog: [],
    });
    const result = QueueSchema.safeParse(queue);
    expect(result.success).toBe(true);
    if (result.success) {
      // All steps pending
      for (const s of result.data.steps) {
        expect(s.status).toBe("pending");
      }
      // All IDs unique
      const ids = result.data.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Correct types
      expect(result.data.steps.map((s) => s.type)).toEqual(["plan", "work", "review"]);
    }
  });
});
