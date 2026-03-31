import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/queue/steps/sprint-work/types";
import type { BoundariesConfig } from "../src/config/loader";
import { SPRINT_FIELDS } from "../src/queue/steps/sprint-work/fields";
import { renderHandoffInstruction } from "../src/queue/shared/handoff-render";

// ---------------------------------------------------------------------------
// Imports for prompt builders
// ---------------------------------------------------------------------------

import { buildSprintStepPrompt } from "../src/queue/steps/sprint-work/step-prompt";
import { buildSprintRevisionPrompt } from "../src/queue/steps/sprint-work/revision-prompt";
import {
  buildSprintEvaluatorPrompt,
  SPRINT_EVALUATOR_SYSTEM_PROMPT,
  SPRINT_EVALUATOR_ADDENDUM,
} from "../src/queue/steps/sprint-work/evaluator";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCtx: WorkflowStepContext = {
  planContent: "Add a hello-world REST endpoint that returns { message: 'hello world' }",
  keyDecisions: [],
  fileReferences: [],
  projectCwd: "/home/user/my-project",
};

const ctxWithContext: WorkflowStepContext = {
  ...baseCtx,
  extra: {
    conventions: [
      { name: "AGENTS.md", path: "AGENTS.md", summary: "Project architecture and coding conventions" },
    ],
    standards: [
      { name: "Testing", path: "docs/standards/testing.md", summary: "Testing patterns" },
    ],
    learnings: [
      { name: "Retry fix", path: ".flywheel/solutions/retry.md", summary: "Retry pattern for network calls" },
    ],
    handoffPath: ".flywheel/handoffs/test-uuid.json",
  },
};

const ctxWithBoundaries: WorkflowStepContext = {
  ...baseCtx,
  extra: {
    handoffPath: ".flywheel/handoffs/test-uuid.json",
    boundaries: {
      port_ranges: ["3000-3999"],
      off_limits_dirs: ["/etc", "/usr"],
      external_services: ["Do not call production API"],
    } satisfies BoundariesConfig,
  },
};

const ctxWithHandoffPath: WorkflowStepContext = {
  ...baseCtx,
  extra: {
    handoffPath: ".flywheel/handoffs/test-uuid.json",
  },
};

// ---------------------------------------------------------------------------
// Revision prompt fixtures
// ---------------------------------------------------------------------------

interface SprintIterationSummary {
  iteration: number;
  workerSummary: string;
  evaluatorFeedback?: {
    implementation: string;
    script: string;
  };
  verificationOutput?: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  scriptContent?: string;
}

const previousIterations: SprintIterationSummary[] = [
  {
    iteration: 1,
    workerSummary: "Created hello.ts with Express route, wrote verification script that curls /hello.",
    evaluatorFeedback: {
      implementation: "Missing error handling for network failures.",
      script: "Script does not test error cases, only happy path.",
    },
    verificationOutput: {
      stdout: "GET /hello returned 200",
      stderr: "",
      exitCode: 1,
    },
    scriptContent: 'const res = await fetch("http://localhost:3000/hello"); if (res.status !== 200) process.exit(1);',
  },
  {
    iteration: 2,
    workerSummary: "Added error handling and timeout, updated verification script with error case.",
    evaluatorFeedback: {
      implementation: "Error handling is present but timeout value is hardcoded.",
      script: "Script now tests error case but doesn't verify response body.",
    },
    verificationOutput: {
      stdout: "GET /hello returned 200\nError case returned 500",
      stderr: "Warning: timeout not configurable",
      exitCode: 1,
    },
    scriptContent: 'const res = await fetch("http://localhost:3000/hello"); if (res.status !== 200) process.exit(1); /* error test */ try { await fetch("http://localhost:3000/error"); } catch(e) { /* ok */ }',
  },
];

// ---------------------------------------------------------------------------
// Evaluator prompt fixtures
// ---------------------------------------------------------------------------

interface SprintEvaluatorInput {
  taskDescription: string;
  iterationNumber: number;
  maxIterations: number;
  workerHandoff: {
    summary: string;
    artifacts?: { files_created?: string[]; files_modified?: string[] };
    verification?: { tests_passed: boolean | null; test_output_summary?: string };
    verification_script_path?: string;
  };
  verificationResult: {
    stdout: string;
    stderr: string;
    exitCode: number;
    passed: boolean;
  };
  currentScriptContent: string;
  previousScripts?: string[];
  handoffPath: string;
}

const evaluatorInput: SprintEvaluatorInput = {
  taskDescription: "Add a hello-world endpoint",
  iterationNumber: 2,
  maxIterations: 5,
  workerHandoff: {
    summary: "Implemented endpoint, wrote verification script.",
    artifacts: { files_created: ["src/hello.ts"], files_modified: ["src/app.ts"] },
    verification: { tests_passed: true, test_output_summary: "3/3 pass" },
    verification_script_path: ".flywheel/verify/sprint-hello.ts",
  },
  verificationResult: {
    stdout: "All checks passed",
    stderr: "",
    exitCode: 0,
    passed: true,
  },
  currentScriptContent: 'const res = await fetch("http://localhost:3000/hello"); assert(res.status === 200);',
  previousScripts: [
    'const res = await fetch("http://localhost:3000/hello"); if (res.status !== 200) process.exit(1);',
  ],
  handoffPath: ".flywheel/handoffs/eval-uuid.json",
};

// ===========================================================================
// VAL-PROMPT-001: First iteration prompt structure
// ===========================================================================

describe("buildSprintStepPrompt", () => {
  it("includes task description", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("hello-world REST endpoint");
  });

  it("includes codebase exploration instruction", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    // Should instruct the worker to explore the codebase
    expect(result.toLowerCase()).toContain("explore");
    expect(result.toLowerCase()).toContain("codebase");
  });

  it("includes implementation instruction", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result.toLowerCase()).toContain("implement");
  });

  it("includes verification script writing instruction", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("verification script");
    expect(result).toContain(".flywheel/verify/");
  });

  it("includes handoff instruction with verification_script_path", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("verification_script_path");
    expect(result).toContain(".flywheel/handoffs/test-uuid.json");
  });

  it("includes working directory", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("/home/user/my-project");
  });

  it("does NOT include 'Previous Attempts' section", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).not.toContain("Previous Attempts");
    expect(result).not.toContain("Iteration");
    // Should not have retry-specific language
    expect(result).not.toContain("do not start from scratch");
  });

  it("includes TDD cycle convention", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("TDD");
  });

  it("enforces TDD-first ordering: verification script BEFORE implementation", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    // Verification/RED step should appear before implementation/GREEN step
    const redIndex = result.indexOf("RED");
    const greenIndex = result.indexOf("GREEN");
    expect(redIndex).toBeGreaterThan(-1);
    expect(greenIndex).toBeGreaterThan(-1);
    expect(redIndex).toBeLessThan(greenIndex);
    // "Write the Verification Script FIRST" should appear before "Implement"
    const verifyFirstIndex = result.indexOf("Write the Verification Script FIRST");
    const implementIndex = result.indexOf("Implement Until Verification Passes");
    expect(verifyFirstIndex).toBeGreaterThan(-1);
    expect(implementIndex).toBeGreaterThan(-1);
    expect(verifyFirstIndex).toBeLessThan(implementIndex);
  });

  it("instructs running the script to confirm it FAILS (RED phase)", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("Run the script now");
    expect(result).toContain("FAILS");
    expect(result).toContain("RED phase");
  });

  it("includes scope discipline convention", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("Scope Discipline");
  });

  it("includes three-strike protocol", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("Three-Strike");
  });

  it("includes knowledge library instruction", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain(".flywheel/library/");
  });

  it("produces non-empty output", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles minimal context without crashing", () => {
    const minCtx: WorkflowStepContext = {
      planContent: "Fix the bug",
      keyDecisions: [],
      fileReferences: [],
      extra: { handoffPath: ".flywheel/handoffs/min.json" },
    };
    const result = buildSprintStepPrompt(minCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses renderHandoffInstruction with SPRINT_FIELDS", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    // The rendered output should contain all SPRINT_FIELDS keys
    for (const field of SPRINT_FIELDS) {
      expect(result).toContain(field.key);
    }
  });
});

// ===========================================================================
// VAL-PROMPT-002: Verification script requirements are explicit and behavioral
// ===========================================================================

describe("buildSprintStepPrompt — verification requirements", () => {
  it("specifies exit 0 = pass, non-zero = fail", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).toContain("exit 0");
    // Should mention non-zero = fail
    expect(result.toLowerCase()).toContain("non-zero");
  });

  it("demands behavioral testing (not just compilation)", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    // Should explicitly require runtime behavior testing
    expect(result.toLowerCase()).toContain("runtime behavior");
    // Should forbid trivial checks
    expect(result.toLowerCase()).toContain("not just compilation");
  });

  it("requires meaningful output from scripts", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result.toLowerCase()).toContain("meaningful output");
  });
});

// ===========================================================================
// VAL-PROMPT-010: Prompt includes project conventions and boundaries
// ===========================================================================

describe("buildSprintStepPrompt — conventions and boundaries", () => {
  it("includes project context section when conventions are set", () => {
    const result = buildSprintStepPrompt(ctxWithContext);
    expect(result).toContain("Project Context");
    expect(result).toContain("Conventions");
    expect(result).toContain("AGENTS.md");
  });

  it("includes boundaries when configured", () => {
    const result = buildSprintStepPrompt(ctxWithBoundaries);
    expect(result).toContain("Mission Boundaries");
    expect(result).toContain("3000-3999");
    expect(result).toContain("Do not call production API");
  });

  it("omits boundaries when not configured", () => {
    const result = buildSprintStepPrompt(ctxWithHandoffPath);
    expect(result).not.toContain("Mission Boundaries");
  });
});

// ===========================================================================
// VAL-PROMPT-003: Retry prompt includes cumulative context
// ===========================================================================

describe("buildSprintRevisionPrompt", () => {
  it("includes iteration counter ('Iteration N of M')", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    expect(result).toContain("Iteration 3 of 5");
  });

  it("includes ALL previous attempt summaries", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    expect(result).toContain("Created hello.ts with Express route");
    expect(result).toContain("Added error handling and timeout");
  });

  it("includes ALL previous evaluator feedback — both channels", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    // Implementation feedback
    expect(result).toContain("Missing error handling for network failures");
    expect(result).toContain("timeout value is hardcoded");
    // Script feedback
    expect(result).toContain("Script does not test error cases");
    expect(result).toContain("doesn't verify response body");
  });

  it("includes ALL previous verification outputs", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    expect(result).toContain("GET /hello returned 200");
    expect(result).toContain("Error case returned 500");
  });

  it("instructs updating existing work, not starting from scratch", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    expect(result.toLowerCase()).toContain("do not start from scratch");
  });

  it("includes task description", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 3,
      maxIterations: 5,
      previousIterations,
    });
    expect(result).toContain("hello-world REST endpoint");
  });

  it("includes handoff instruction", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 2,
      maxIterations: 5,
      previousIterations: [previousIterations[0]],
    });
    expect(result).toContain("verification_script_path");
    expect(result).toContain(".flywheel/handoffs/test-uuid.json");
  });

  it("includes working directory", () => {
    const result = buildSprintRevisionPrompt({
      ctx: ctxWithHandoffPath,
      currentIteration: 2,
      maxIterations: 5,
      previousIterations: [previousIterations[0]],
    });
    expect(result).toContain("/home/user/my-project");
  });
});

// ===========================================================================
// VAL-PROMPT-004: Handoff instruction uses sprint-specific field set
// ===========================================================================

describe("SPRINT_FIELDS and renderHandoffInstruction", () => {
  it("SPRINT_FIELDS is defined and includes verification_script_path", () => {
    expect(SPRINT_FIELDS).toBeDefined();
    expect(Array.isArray(SPRINT_FIELDS)).toBe(true);
    const keys = SPRINT_FIELDS.map((f) => f.key);
    expect(keys).toContain("verification_script_path");
    expect(keys).toContain("summary");
  });

  it("renderHandoffInstruction produces output with SPRINT_FIELDS", () => {
    const rendered = renderHandoffInstruction(SPRINT_FIELDS, ".flywheel/handoffs/test.json");
    expect(rendered).toContain("verification_script_path");
    expect(rendered).toContain(".flywheel/handoffs/test.json");
    expect(rendered).toContain("summary");
  });
});

// ===========================================================================
// VAL-PROMPT-005: Evaluator prompt is adversarial — no bias-toward-passing
// ===========================================================================

describe("buildSprintEvaluatorPrompt — adversarial framing", () => {
  it("does NOT contain 'Bias Toward Passing'", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).not.toContain("Bias Toward Passing");
  });

  it("does NOT contain 'When in doubt, pass with suggestions'", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).not.toContain("When in doubt, pass with suggestions");
  });

  it("does NOT contain 'pass with suggestions rather than fail'", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).not.toContain("pass with suggestions rather than fail");
  });

  it("contains adversarial framing — find problems, don't rubber-stamp", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    // Should have adversarial instructions
    const lower = result.toLowerCase();
    expect(lower).toContain("adversarial");
  });

  it("when in doubt instructs FAIL (not pass)", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    // Should instruct failing when in doubt
    expect(result.toLowerCase()).toContain("when in doubt");
    expect(result.toLowerCase()).toContain("fail");
  });
});

// ===========================================================================
// VAL-PROMPT-006: Evaluator assesses both implementation and script quality
// ===========================================================================

describe("buildSprintEvaluatorPrompt — dual-channel assessment", () => {
  it("has implementation assessment dimension", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result.toLowerCase()).toContain("implementation");
  });

  it("has script quality assessment dimension", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    // Should assess the verification script quality
    expect(result.toLowerCase()).toContain("script");
    expect(result.toLowerCase()).toContain("quality");
  });

  it("requires both channels to pass", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    // Should indicate both must pass
    expect(result.toLowerCase()).toContain("both");
  });
});

// ===========================================================================
// VAL-PROMPT-007: Evaluator detects script weakening
// ===========================================================================

describe("buildSprintEvaluatorPrompt — script weakening detection", () => {
  it("receives previous scripts for comparison", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    // Should contain the previous script content
    expect(result).toContain('if (res.status !== 200) process.exit(1)');
  });

  it("contains script weakening detection instructions", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    const lower = result.toLowerCase();
    expect(lower).toContain("weaken");
  });

  it("instructs failure if assertions were removed or trivialized", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    const lower = result.toLowerCase();
    // Should instruct to fail when assertions are weakened
    expect(lower).toContain("removed");
  });

  it("handles case with no previous scripts (first iteration)", () => {
    const firstIterationInput: SprintEvaluatorInput = {
      ...evaluatorInput,
      iterationNumber: 1,
      previousScripts: undefined,
    };
    const result = buildSprintEvaluatorPrompt(firstIterationInput);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// VAL-PROMPT-008: Evaluator provides dual-channel actionable feedback
// ===========================================================================

describe("buildSprintEvaluatorPrompt — dual-channel feedback", () => {
  it("instructs separate implementation_feedback and script_feedback", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("implementation_feedback");
    expect(result).toContain("script_feedback");
  });

  it("requests specific and actionable feedback", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    const lower = result.toLowerCase();
    expect(lower).toContain("actionable");
  });
});

// ===========================================================================
// VAL-PROMPT-009: Evaluator receives full context
// ===========================================================================

describe("buildSprintEvaluatorPrompt — full context", () => {
  it("includes task description", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("Add a hello-world endpoint");
  });

  it("includes iteration number", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("Iteration 2 of 5");
  });

  it("includes verification script source code", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain('assert(res.status === 200)');
  });

  it("includes verification result", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("All checks passed");
  });

  it("includes worker handoff summary", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("Implemented endpoint, wrote verification script.");
  });
});

// ===========================================================================
// VAL-PROMPT-011: Sprint evaluator transport does not inject bias-toward-passing
// ===========================================================================

describe("SPRINT_EVALUATOR_SYSTEM_PROMPT", () => {
  it("is defined as a string", () => {
    expect(typeof SPRINT_EVALUATOR_SYSTEM_PROMPT).toBe("string");
    expect(SPRINT_EVALUATOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("does NOT contain 'Bias Toward Passing'", () => {
    expect(SPRINT_EVALUATOR_SYSTEM_PROMPT).not.toContain("Bias Toward Passing");
  });

  it("does NOT contain 'When in doubt, pass'", () => {
    expect(SPRINT_EVALUATOR_SYSTEM_PROMPT).not.toContain("When in doubt, pass");
  });

  it("identifies the role as adversarial evaluator", () => {
    const lower = SPRINT_EVALUATOR_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("evaluator");
  });
});

// ===========================================================================
// VAL-PROMPT-012: SPRINT_FIELDS HandoffFieldSpec array defined and used
// ===========================================================================

describe("SPRINT_FIELDS HandoffFieldSpec", () => {
  it("is an array with at least 2 entries", () => {
    expect(SPRINT_FIELDS.length).toBeGreaterThanOrEqual(2);
  });

  it("includes verification_script_path field", () => {
    const field = SPRINT_FIELDS.find((f) => f.key === "verification_script_path");
    expect(field).toBeDefined();
    expect(field!.description).toBeTruthy();
    expect(field!.example).toBeTruthy();
  });

  it("includes required summary field", () => {
    const field = SPRINT_FIELDS.find((f) => f.key === "summary");
    expect(field).toBeDefined();
    expect(field!.required).toBe(true);
  });

  it("all fields have key, description, and example", () => {
    for (const field of SPRINT_FIELDS) {
      expect(typeof field.key).toBe("string");
      expect(typeof field.description).toBe("string");
      expect(typeof field.example).toBe("string");
      expect(field.description.length).toBeGreaterThan(0);
      expect(field.example.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Evaluator handoff instruction (in evaluator prompt)
// ===========================================================================

describe("buildSprintEvaluatorPrompt — handoff instruction", () => {
  it("includes handoff path", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain(".flywheel/handoffs/eval-uuid.json");
  });

  it("includes evaluator verdict fields (passed, reasoning, etc.)", () => {
    const result = buildSprintEvaluatorPrompt(evaluatorInput);
    expect(result).toContain("passed");
    expect(result).toContain("reasoning");
    expect(result).toContain("feedback");
  });
});

// ===========================================================================
// SPRINT_EVALUATOR_ADDENDUM — sprint-specific system prompt addendum
// ===========================================================================

describe("SPRINT_EVALUATOR_ADDENDUM", () => {
  it("is a non-empty string", () => {
    expect(typeof SPRINT_EVALUATOR_ADDENDUM).toBe("string");
    expect(SPRINT_EVALUATOR_ADDENDUM.length).toBeGreaterThan(0);
  });

  it("contains dual-channel assessment instructions", () => {
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("Dual-Channel Assessment");
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("Implementation Quality");
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("Verification Script Quality");
  });

  it("contains script weakening detection instructions", () => {
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("Script Weakening Detection");
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("CRITICAL");
  });

  it("contains adversarial framing", () => {
    expect(SPRINT_EVALUATOR_ADDENDUM).toContain("adversarial");
    expect(SPRINT_EVALUATOR_ADDENDUM.toLowerCase()).toContain("when in doubt");
    expect(SPRINT_EVALUATOR_ADDENDUM.toLowerCase()).toContain("fail");
  });

  it("does NOT duplicate the base evaluator system prompt", () => {
    // The addendum should not contain the full base prompt text
    expect(SPRINT_EVALUATOR_ADDENDUM).not.toContain("You are a verification agent");
    expect(SPRINT_EVALUATOR_ADDENDUM).not.toContain("Re-run claimed commands");
  });

  it("does NOT contain bias-toward-passing language", () => {
    expect(SPRINT_EVALUATOR_ADDENDUM).not.toContain("Bias Toward Passing");
    expect(SPRINT_EVALUATOR_ADDENDUM).not.toContain("When in doubt, pass");
  });
});


