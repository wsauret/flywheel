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
} from "../src/workflows/queue/schemas";

import type {
  StepType,
  StepStatus,
  Step,
  QueueStatus,
  MutationLogEntry,
  Queue,
  WorkflowTemplate,
} from "../src/workflows/queue/types";

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

  // ---------------------------------------------------------------------------
  // VAL-EXEC-011: Step carries all ADR-004 Decision 2 fields
  // ---------------------------------------------------------------------------

  test("accepts optional description string", () => {
    const step = validStep({ description: "Implement GET /hello endpoint" });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Implement GET /hello endpoint");
    }
  });

  test("accepts optional dispatcherHint string", () => {
    const step = validStep({ dispatcherHint: "Focus on error handling" });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dispatcherHint).toBe("Focus on error handling");
    }
  });

  test("accepts optional toolScoping object", () => {
    const scoping = { read: true, bash: true, write: true, edit: false };
    const step = validStep({ toolScoping: scoping });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolScoping).toEqual(scoping);
    }
  });

  test("rejects toolScoping with missing fields", () => {
    const step = { ...validStep(), toolScoping: { read: true, bash: true } };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects toolScoping with extra fields", () => {
    const step = {
      ...validStep(),
      toolScoping: { read: true, bash: true, write: true, edit: true, extra: true },
    };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("accepts optional evaluationCriteria string", () => {
    const step = validStep({ evaluationCriteria: "Produces a .context.md file" });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.evaluationCriteria).toBe("Produces a .context.md file");
    }
  });

  test("accepts optional acceptanceCriteria array", () => {
    const criteria = ["GET /hello returns 200", "Response includes timestamp"];
    const step = validStep({ acceptanceCriteria: criteria });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.acceptanceCriteria).toEqual(criteria);
    }
  });

  test("accepts optional fileReferences array", () => {
    const refs = ["src/server/index.ts", "tests/server.test.ts"];
    const step = validStep({ fileReferences: refs });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileReferences).toEqual(refs);
    }
  });

  test("accepts optional hitl object with prompt and enabled", () => {
    const hitl = { prompt: "Review these findings", enabled: true };
    const step = validStep({ hitl });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hitl).toEqual(hitl);
    }
  });

  test("accepts hitl with enabled=false", () => {
    const hitl = { prompt: "Resolve autonomously", enabled: false };
    const step = validStep({ hitl });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hitl?.enabled).toBe(false);
    }
  });

  test("rejects hitl missing prompt field", () => {
    const step = { ...validStep(), hitl: { enabled: true } };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects hitl missing enabled field", () => {
    const step = { ...validStep(), hitl: { prompt: "Review" } };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("rejects hitl with extra fields", () => {
    const step = { ...validStep(), hitl: { prompt: "Review", enabled: true, extra: "bad" } };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(false);
  });

  test("accepts optional feature string", () => {
    const step = validStep({ feature: "auth" });
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feature).toBe("auth");
    }
  });

  test("accepts step with ALL ADR-004 fields populated", () => {
    const step = {
      ...validStep(),
      description: "Implement auth module",
      dispatcherHint: "Focus on security",
      toolScoping: { read: true, bash: true, write: true, edit: true },
      evaluationCriteria: "Tests pass, files exist",
      acceptanceCriteria: ["Auth middleware works", "Tests added"],
      fileReferences: ["src/auth/middleware.ts"],
      hitl: { prompt: "Review security", enabled: true },
      feature: "auth",
      fulfills: ["VAL-AUTH-001"],
      dependsOn: ["step-uuid-1"],
      milestone: "core-execution",
    };
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Implement auth module");
      expect(result.data.dispatcherHint).toBe("Focus on security");
      expect(result.data.toolScoping).toEqual({ read: true, bash: true, write: true, edit: true });
      expect(result.data.evaluationCriteria).toBe("Tests pass, files exist");
      expect(result.data.acceptanceCriteria).toEqual(["Auth middleware works", "Tests added"]);
      expect(result.data.fileReferences).toEqual(["src/auth/middleware.ts"]);
      expect(result.data.hitl).toEqual({ prompt: "Review security", enabled: true });
      expect(result.data.feature).toBe("auth");
      expect(result.data.fulfills).toEqual(["VAL-AUTH-001"]);
      expect(result.data.dependsOn).toEqual(["step-uuid-1"]);
      expect(result.data.milestone).toBe("core-execution");
    }
  });

  test("step without optional ADR-004 fields is valid", () => {
    const step = validStep();
    const result = StepSchema.safeParse(step);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBeUndefined();
      expect(result.data.dispatcherHint).toBeUndefined();
      expect(result.data.toolScoping).toBeUndefined();
      expect(result.data.evaluationCriteria).toBeUndefined();
      expect(result.data.acceptanceCriteria).toBeUndefined();
      expect(result.data.fileReferences).toBeUndefined();
      expect(result.data.hitl).toBeUndefined();
      expect(result.data.feature).toBeUndefined();
    }
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
      validStep({ type: "plan", title: "Plan step" }),
      validStep({ type: "work", title: "Work step" }),
      validStep({ type: "review", title: "Review step" }),
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
