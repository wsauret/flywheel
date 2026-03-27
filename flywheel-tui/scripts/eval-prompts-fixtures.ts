/**
 * eval-prompts-fixtures.ts — Test scenario fixtures, judge prompt construction,
 * and comparison helpers for the prompt evaluation infrastructure.
 *
 * Extracted into a separate module so it can be imported by both the
 * eval-prompts.ts script and its unit tests.
 */

import type { DispatcherInput } from "../src/schemas/dispatcher";
import type { EvaluatorInput } from "../src/schemas/evaluator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestScenario {
  name: "simple" | "complex" | "edge";
  description: string;
  dispatcherInput: DispatcherInput;
  evaluatorInput: EvaluatorInput;
}

export interface DispatcherJudgeScores {
  clarity: number;
  completeness: number;
  actionability: number;
  clarity_reason: string;
  completeness_reason: string;
  actionability_reason: string;
}

export interface EvaluatorJudgeScores {
  accuracy: number;
  thoroughness: number;
  usefulness: number;
  accuracy_reason: string;
  thoroughness_reason: string;
  usefulness_reason: string;
}

export interface ScenarioResult {
  scenario: string;
  dispatcher: {
    timing_ms: number;
    schema_valid: boolean;
    raw_output: string;
    parsed_decision: unknown | null;
  };
  evaluator: {
    timing_ms: number;
    schema_valid: boolean;
    raw_output: string;
    parsed_result: unknown | null;
  };
  judge: {
    dispatcher_scores: DispatcherJudgeScores | null;
    evaluator_scores: EvaluatorJudgeScores | null;
  };
}

export interface EvalSummary {
  run_id: string;
  timestamp: string;
  engine: string;
  scenarios: ScenarioResult[];
}

// ---------------------------------------------------------------------------
// SIMPLE scenario — single-phase, no context, no budget
// ---------------------------------------------------------------------------

export function buildSimpleScenario(): TestScenario {
  const dispatcherInput: DispatcherInput = {
    plan: {
      steps: [
        { title: "Create hello endpoint", description: "Create src/routes/hello.ts with GET handler returning { message: 'hello world' }" },
        { title: "Add hello test", description: "Add test in tests/hello.test.ts verifying 200 response and body" },
        { title: "Register route", description: "Register the route in src/routes/index.ts" },
      ],
    },
    state: {
      completed_steps: [],
      current_step_index: 0,
    },
    context: { files: [] },
    plan_truncated: false,
    history_truncated: false,
    workflow_id: "eval-simple-001",
    workflow: {
      name: "work",
      step_number: 1,
      total_steps: 1,
      step_description: "Add hello world endpoint",
    },
    last_worker_result: null,
    config: {
      max_eval_cycles: 3,
      worktree_path: "",
      project_cwd: "/tmp/test-project",
      worker_model: "opus",
      dispatcher_model: "sonnet",
    },
    session_budget: {
      invocations_remaining: null,
      token_budget_remaining: null,
      wall_clock_deadline: null,
    },
    available_context: {
      conventions: [],
      standards: [],
      learnings: [],
    },
  };

  const evaluatorInput: EvaluatorInput = {
    worker_output: `## Implementation Complete

I've created the GET /hello endpoint as requested.

### Changes Made
1. Created \`src/routes/hello.ts\` with a GET handler
2. Added tests in \`tests/hello.test.ts\`
3. Registered route in \`src/routes/index.ts\`

### Test Results
All 2 tests pass:
- GET /hello returns 200
- Response body is { message: "hello world" }
`,
    validation_criteria: "Acceptance criteria:\n- GET /hello endpoint returns 200\n- Response body is { message: \"hello world\" }\n- Tests pass",
    context_files: [],
    acceptance_criteria: [
      "GET /hello endpoint returns 200",
      "Response body is { message: \"hello world\" }",
      "Tests pass",
    ],
    artifacts_produced: ["src/routes/hello.ts", "tests/hello.test.ts", "src/routes/index.ts"],
    tests_passed: true,
    duration_seconds: 30,
  };

  return {
    name: "simple",
    description: "Single-phase plan with no prior history, no context, no budget constraints",
    dispatcherInput,
    evaluatorInput,
  };
}

// ---------------------------------------------------------------------------
// COMPLEX scenario — multi-phase, context, budget, last_worker_result
// ---------------------------------------------------------------------------

export function buildComplexScenario(): TestScenario {
  const dispatcherInput: DispatcherInput = {
    plan: {
      steps: [
        { title: "Set up project structure", description: "Initialize project with package.json and tsconfig.json. Create src/ and tests/ directories." },
        { title: "Implement data models", description: "Create User model with Zod schema in src/models/user.ts. Create Post model with Zod schema in src/models/post.ts. Add unit tests for both models." },
        { title: "Build REST API endpoints", description: "Create GET /users endpoint with pagination. Create POST /users endpoint with validation. Create GET /posts and POST /posts endpoints. Add integration tests." },
        { title: "Add authentication middleware", description: "Implement JWT authentication middleware. Protect POST endpoints with auth middleware. Add auth tests." },
        { title: "Documentation and cleanup", description: "Generate OpenAPI spec from route handlers. Add README with setup instructions." },
      ],
    },
    state: {
      completed_steps: [0, 1],
      current_step_index: 2,
    },
    context: { files: ["src/models/user.ts", "src/models/post.ts"] },
    plan_truncated: false,
    history_truncated: false,
    workflow_id: "eval-complex-001",
    workflow: {
      name: "work",
      step_number: 3,
      total_steps: 5,
      step_description: "Build REST API endpoints",
    },
    last_worker_result: {
      step: 1,
      status: "completed",
      output_summary: "Created User and Post Zod schemas with validation. All 8 unit tests pass.",
      artifacts_produced: ["src/models/user.ts", "src/models/post.ts", "tests/models.test.ts"],
      tests_passed: true,
      duration_seconds: 120,
    },
    config: {
      max_eval_cycles: 3,
      worktree_path: "/tmp/worktree-complex",
      project_cwd: "/tmp/test-project",
      worker_model: "opus",
      dispatcher_model: "sonnet",
    },
    session_budget: {
      invocations_remaining: 8,
      token_budget_remaining: 500000,
      wall_clock_deadline: null,
    },
    available_context: {
      conventions: [
        { name: "AGENTS.md", path: "AGENTS.md", summary: "Project coding conventions and architecture" },
      ],
      standards: [
        { name: "Testing Standards", path: "docs/standards/testing.md", summary: "Testing patterns and conventions" },
        { name: "API Standards", path: "docs/standards/api.md", summary: "REST API design guidelines" },
      ],
      learnings: [
        { name: "Zod validation patterns", path: "docs/solutions/zod-patterns.md", summary: "Effective Zod schema patterns discovered" },
      ],
    },
  };

  const evaluatorInput: EvaluatorInput = {
    worker_output: `## REST API Endpoints Implementation

### Changes Made

1. **GET /users** — Implemented with cursor-based pagination (limit/offset). Returns JSON array.
   - File: \`src/routes/users.ts\`
   - Validates query params with Zod

2. **POST /users** — Creates a new user with Zod validation on the request body.
   - File: \`src/routes/users.ts\`
   - Returns 201 on success, 400 on validation error

3. **GET /posts** — Lists posts with optional \`?author=<id>\` filter.
   - File: \`src/routes/posts.ts\`

4. **POST /posts** — Creates a new post with validation.
   - File: \`src/routes/posts.ts\`

### Integration Tests
\`\`\`
10 tests, 10 pass
- GET /users returns paginated list
- POST /users creates user successfully
- POST /users rejects invalid body
- GET /posts returns all posts
- GET /posts filters by author
- POST /posts creates post
\`\`\`

### Files
- src/routes/users.ts (new)
- src/routes/posts.ts (new)
- tests/api.test.ts (new)
`,
    validation_criteria:
      "Acceptance criteria:\n" +
      "- GET /users endpoint with pagination\n" +
      "- POST /users with validation\n" +
      "- GET /posts with author filtering\n" +
      "- POST /posts with validation\n" +
      "- Integration tests for all endpoints\n" +
      "Required: tests must pass",
    context_files: ["src/models/user.ts", "src/models/post.ts"],
    acceptance_criteria: [
      "GET /users endpoint with pagination",
      "POST /users with validation",
      "GET /posts with author filtering",
      "POST /posts with validation",
      "Integration tests for all endpoints",
    ],
    artifacts_produced: ["src/routes/users.ts", "src/routes/posts.ts", "tests/api.test.ts"],
    tests_passed: true,
    duration_seconds: 180,
  };

  return {
    name: "complex",
    description: "Multi-step plan (5 steps, 2 completed) with context entries, last_worker_result, and budget constraints",
    dispatcherInput,
    evaluatorInput,
  };
}

// ---------------------------------------------------------------------------
// EDGE scenario — truncated plan, tight budget, failed result
// ---------------------------------------------------------------------------

export function buildEdgeScenario(): TestScenario {
  const dispatcherInput: DispatcherInput = {
    plan: {
      steps: [
        { title: "Initial setup", description: "Initial project setup (completed)" },
        { title: "Fix failing tests", description: "Investigate test failure in auth middleware. Fix the root cause. Verify all tests pass." },
      ],
    },
    state: {
      completed_steps: [0],
      current_step_index: 1,
    },
    context: { files: ["src/middleware/auth.ts", "tests/auth.test.ts"] },
    plan_truncated: true,
    history_truncated: true,
    workflow_id: "eval-edge-001",
    workflow: {
      name: "work",
      step_number: 2,
      total_steps: 2,
      step_description: "Fix failing tests",
    },
    last_worker_result: {
      step: 0,
      status: "failed",
      output_summary: "Attempted to fix auth middleware but introduced a regression. 3 tests now failing.",
      artifacts_produced: ["src/middleware/auth.ts"],
      tests_passed: false,
      duration_seconds: 300,
    },
    config: {
      max_eval_cycles: 1,
      worktree_path: "/tmp/worktree-edge",
      project_cwd: "/tmp/test-project",
      worker_model: "sonnet",
      dispatcher_model: "sonnet",
    },
    session_budget: {
      invocations_remaining: 2,
      token_budget_remaining: 50000,
      wall_clock_deadline: new Date(Date.now() + 600_000).toISOString(), // 10 minutes
    },
    available_context: {
      conventions: [],
      standards: [],
      learnings: [],
    },
  };

  const evaluatorInput: EvaluatorInput = {
    worker_output: `## Attempted Fix

I investigated the auth middleware test failures:

### Root Cause
The JWT verification was using an expired secret key. Updated the key rotation logic.

### Changes
- Modified \`src/middleware/auth.ts\` to use the new key rotation approach
- However, 1 of 3 tests still fails — the token refresh test needs the mock to be updated

### Test Results
\`\`\`
3 tests, 2 pass, 1 fail
- PASS: Valid token accepted
- PASS: Expired token rejected
- FAIL: Token refresh generates new valid token (mock issue)
\`\`\`

I ran out of time before fixing the remaining test.
`,
    validation_criteria:
      "Acceptance criteria:\n" +
      "- Auth middleware test failure is fixed\n" +
      "- All 3 auth tests pass\n" +
      "Required: tests must pass",
    context_files: ["src/middleware/auth.ts", "tests/auth.test.ts"],
    acceptance_criteria: [
      "Auth middleware test failure is fixed",
      "All 3 auth tests pass",
    ],
    artifacts_produced: ["src/middleware/auth.ts"],
    tests_passed: false,
    duration_seconds: 300,
  };

  return {
    name: "edge",
    description: "Truncated plan with tight budget, failed last_worker_result, and incomplete fix",
    dispatcherInput,
    evaluatorInput,
  };
}

// ---------------------------------------------------------------------------
// Build all scenarios
// ---------------------------------------------------------------------------

export function buildAllScenarios(): TestScenario[] {
  return [buildSimpleScenario(), buildComplexScenario(), buildEdgeScenario()];
}

// ---------------------------------------------------------------------------
// Judge prompt construction
// ---------------------------------------------------------------------------

/**
 * Build a judge prompt for evaluating dispatcher output quality.
 * Designed to be < 500 tokens.
 */
export function buildDispatcherJudgePrompt(
  phaseDescription: string,
  taskContent: string,
): string {
  return `Score this dispatcher output on 3 dimensions (1-5 each).

## Phase Description
${phaseDescription}

## Dispatcher's Task Content
${taskContent}

## Scoring Dimensions
- **Clarity** (1-5): Is the task description clear and unambiguous?
- **Completeness** (1-5): Does it cover all the steps in the plan phase?
- **Actionability** (1-5): Could a worker execute this without needing to ask questions?

Respond with JSON only:
{"clarity":N,"completeness":N,"actionability":N,"clarity_reason":"...","completeness_reason":"...","actionability_reason":"..."}`;
}

/**
 * Build a judge prompt for evaluating evaluator output quality.
 * Designed to be < 500 tokens.
 */
export function buildEvaluatorJudgePrompt(
  workerOutput: string,
  criteria: string,
  evaluatorResult: { passed: boolean; reasoning: string; confidence: number },
): string {
  return `Score this evaluator assessment on 3 dimensions (1-5 each).

## Worker Output (excerpt)
${workerOutput.slice(0, 500)}

## Criteria
${criteria.slice(0, 300)}

## Evaluator Result
passed: ${evaluatorResult.passed}, confidence: ${evaluatorResult.confidence}
reasoning: ${evaluatorResult.reasoning.slice(0, 300)}

## Scoring Dimensions
- **Accuracy** (1-5): Does the pass/fail decision match the evidence?
- **Thoroughness** (1-5): Does the reasoning address all criteria?
- **Usefulness** (1-5): Are the suggestions actionable?

Respond with JSON only:
{"accuracy":N,"thoroughness":N,"usefulness":N,"accuracy_reason":"...","thoroughness_reason":"...","usefulness_reason":"..."}`;
}

// ---------------------------------------------------------------------------
// Comparison / delta helpers
// ---------------------------------------------------------------------------

/**
 * Calculate the delta between baseline and current scores.
 * Positive = improvement, negative = regression.
 */
export function calculateScoreDelta(
  baseline: Record<string, number>,
  current: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of Object.keys(baseline)) {
    delta[key] = (current[key] ?? 0) - (baseline[key] ?? 0);
  }
  return delta;
}

/**
 * Calculate timing delta between baseline and current.
 * Negative absolute_ms means faster (improvement).
 */
export function calculateTimingDelta(
  baselineMs: number,
  currentMs: number,
): { absolute_ms: number; improved: boolean } {
  const absolute_ms = currentMs - baselineMs;
  return { absolute_ms, improved: absolute_ms < 0 };
}
