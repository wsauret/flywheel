#!/usr/bin/env bun
/**
 * verify-handoff.ts — live API verification of the handoff system.
 *
 * Spawns real LLM subprocesses with handoff instructions, validates that each
 * role (worker, evaluator, dispatcher) writes valid handoff files. This is a
 * live test that requires an API key and engine binary.
 *
 * Scenarios:
 *   1. WORK        — Worker writes summary (100+ chars), artifacts, verification
 *   2. PLAN_CONSOLIDATE — Worker writes summary, plan_file_path
 *   3. REVIEW_CONSOLIDATE — Worker writes summary, review_file_path, finding_counts
 *   4. EVALUATOR   — Evaluator writes passed, reasoning, confidence, etc.
 *   5. DISPATCHER  — Dispatcher writes schema_version=1, phase_index, task_content, context_files
 *
 * Each scenario:
 *   - Generates a unique invocationId
 *   - Builds a prompt with handoff instruction pointing to a temp file
 *   - Spawns a subprocess (real engine)
 *   - Waits for exit
 *   - Reads the handoff file
 *   - Validates the schema
 *   - Checks expected fields are populated
 *
 * Usage:
 *   bun scripts/verify-handoff.ts --engine=opencode --verbose
 *   bun scripts/verify-handoff.ts --engine=claude --verbose
 *   bun scripts/verify-handoff.ts --scenario=WORK --engine=claude
 *   bun scripts/verify-handoff.ts --dry-run
 *   bun scripts/verify-handoff.ts --help
 *
 * Artifacts saved to .flywheel/verify-handoff/ for post-hoc investigation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  readHandoff,
  HandoffMissingError,
  HandoffInvalidError,
} from "../src/queue/shared/handoff-reader";
import { WorkerHandoffSchema } from "../src/queue/shared/handoff-schemas";
import { EvaluatorVerdictSchema } from "../src/evaluator/schemas";
import { DispatcherDecisionHandoffSchema } from "../src/dispatcher/schemas";
import type { ZodSchema } from "zod";
import {
  renderHandoffInstruction,
  renderEvaluatorHandoffInstruction,
  renderDispatcherHandoffInstruction,
} from "../src/queue/shared/handoff-render";
import { WORK_STEP_FIELDS as WORK_PHASE_FIELDS } from "../src/queue/steps/work/fields";
import { PLAN_CONSOLIDATE_FIELDS } from "../src/queue/steps/plan-consolidate/fields";
import { REVIEW_FIELDS } from "../src/queue/steps/review-consolidate/fields";

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pass(msg: string) {
  console.log(`  ${GREEN}PASS${RESET} ${msg}`);
}
function fail(msg: string, detail?: string) {
  console.log(`  ${RED}FAIL${RESET} ${msg}`);
  if (detail) console.log(`       ${DIM}${detail}${RESET}`);
}
function info(msg: string) {
  console.log(`  ${CYAN}INFO${RESET} ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${YELLOW}WARN${RESET} ${msg}`);
}

// ---------------------------------------------------------------------------
// Output directory
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.join(process.cwd(), ".flywheel", "verify-handoff");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function saveArtifact(name: string, content: string): string {
  ensureOutputDir();
  const filePath = path.join(OUTPUT_DIR, `${timestamp}_${name}`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const dryRun = args.includes("--dry-run");
const helpFlag = args.includes("--help");
const engineArg = args
  .find((a) => a.startsWith("--engine="))
  ?.split("=")[1] as "claude" | "opencode" | undefined;
const scenarioArg = args
  .find((a) => a.startsWith("--scenario="))
  ?.split("=")[1]
  ?.toUpperCase();

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

if (helpFlag) {
  console.log(`
${BOLD}verify-handoff.ts${RESET} — live API verification of the handoff system.

${BOLD}Usage:${RESET}
  bun scripts/verify-handoff.ts [options]

${BOLD}Options:${RESET}
  --engine=claude|opencode   Select which engine to test (required for live run)
  --scenario=NAME            Run a single scenario (WORK, PLAN_CONSOLIDATE, REVIEW_CONSOLIDATE, EVALUATOR, DISPATCHER)
  --verbose                  Show full handoff file contents
  --dry-run                  Show assembled prompts, skip LLM calls
  --help                     Show this help message

${BOLD}Scenarios:${RESET}
  WORK               Worker handoff with artifacts, verification, decisions
  PLAN_CONSOLIDATE    Worker handoff with plan_file_path
  REVIEW_CONSOLIDATE  Worker handoff with review_file_path, finding_counts
  EVALUATOR           Evaluator verdict with passed, reasoning, confidence
  DISPATCHER          Dispatcher decision with schema_version, phase_index, task_content

${BOLD}Examples:${RESET}
  bun scripts/verify-handoff.ts --engine=opencode --verbose
  bun scripts/verify-handoff.ts --engine=claude --scenario=WORK
  bun scripts/verify-handoff.ts --dry-run

${BOLD}Artifacts:${RESET}
  Results are saved to .flywheel/verify-handoff/ including:
  - prompt.md           Assembled prompt for each scenario
  - handoff.json        Raw handoff file content
  - timing.json         Wall-clock timing data
  - report.json         Pass/fail summary
`);
  process.exit(0);
}

// Validate --engine flag
if (engineArg && engineArg !== "claude" && engineArg !== "opencode") {
  console.error(
    `${RED}ERROR${RESET}: Invalid --engine value "${engineArg}". Must be "claude" or "opencode".`,
  );
  process.exit(1);
}

if (!dryRun && !engineArg) {
  console.error(
    `${RED}ERROR${RESET}: --engine=claude|opencode is required for live runs. Use --dry-run to preview prompts.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  passed: boolean;
  durationMs: number;
  errors: string[];
  warnings: string[];
}

interface Scenario {
  name: string;
  description: string;
  buildPrompt: (handoffPath: string) => string;
  schema: ZodSchema<any>;
  validate: (parsed: any) => { passed: boolean; errors: string[]; warnings: string[] };
}

function generateInvocationId(): string {
  return `verify-${crypto.randomUUID().slice(0, 8)}`;
}

const SCENARIOS: Scenario[] = [
  {
    name: "WORK",
    description: "Worker writes handoff with summary, artifacts, verification",
    buildPrompt: (hp) => {
      const instruction = renderHandoffInstruction(WORK_PHASE_FIELDS, hp);
      return `You are a worker implementing a software feature.

## Task
Add a GET /health endpoint that returns { status: "ok" } with a 200 response.
Create the handler file and a test file. Run the tests.

${instruction}

IMPORTANT: Your ONLY deliverable is writing the JSON handoff file above. Do NOT actually create any source files.
Instead, simulate the work and write realistic handoff data as if you had completed the task.
The summary MUST be at least 100 characters long.`;
    },
    schema: WorkerHandoffSchema,
    validate: (parsed) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!parsed.summary || parsed.summary.length < 100) {
        errors.push(`summary too short: ${parsed.summary?.length ?? 0} chars (need 100+)`);
      }
      if (!parsed.artifacts) {
        warnings.push("artifacts not populated");
      } else {
        if (!parsed.artifacts.files_created?.length) warnings.push("artifacts.files_created empty");
        if (!parsed.artifacts.commands_run?.length) warnings.push("artifacts.commands_run empty");
      }
      if (!parsed.verification) {
        warnings.push("verification not populated");
      } else {
        if (parsed.verification.tests_passed === undefined) warnings.push("verification.tests_passed not set");
      }

      return { passed: errors.length === 0, errors, warnings };
    },
  },
  {
    name: "PLAN_CONSOLIDATE",
    description: "Worker writes handoff with summary and plan_file_path",
    buildPrompt: (hp) => {
      const instruction = renderHandoffInstruction(PLAN_CONSOLIDATE_FIELDS, hp);
      return `You are a worker consolidating a plan.

## Task
Consolidate the implementation plan for a user authentication system.
Apply user decisions: use Auth0 as the provider, use RS256 for JWT signing.
The final plan should be saved to docs/plans/auth-plan.md.

${instruction}

IMPORTANT: Your ONLY deliverable is writing the JSON handoff file above. Do NOT actually create any files.
Instead, simulate the consolidation and write realistic handoff data.
The summary MUST be at least 100 characters long.
Include plan_file_path pointing to the plan location.`;
    },
    schema: WorkerHandoffSchema,
    validate: (parsed) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!parsed.summary || parsed.summary.length < 100) {
        errors.push(`summary too short: ${parsed.summary?.length ?? 0} chars (need 100+)`);
      }
      if (!parsed.plan_file_path) {
        errors.push("plan_file_path not populated");
      }

      return { passed: errors.length === 0, errors, warnings };
    },
  },
  {
    name: "REVIEW_CONSOLIDATE",
    description: "Worker writes handoff with summary, review_file_path, finding_counts",
    buildPrompt: (hp) => {
      const instruction = renderHandoffInstruction(REVIEW_FIELDS, hp);
      return `You are a worker performing a code review.

## Task
Review the authentication module implementation. Check for:
- Security issues (SQL injection, XSS, CSRF)
- Error handling completeness
- Test coverage
The review document should be saved to docs/reviews/auth-review.md.

${instruction}

IMPORTANT: Your ONLY deliverable is writing the JSON handoff file above. Do NOT actually review any files.
Instead, simulate a realistic review and write handoff data with findings.
The summary MUST be at least 100 characters long.
Include review_file_path and finding_counts (p1_critical, p2_important, p3_suggestion).`;
    },
    schema: WorkerHandoffSchema,
    validate: (parsed) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (!parsed.summary || parsed.summary.length < 100) {
        errors.push(`summary too short: ${parsed.summary?.length ?? 0} chars (need 100+)`);
      }
      if (!parsed.review_file_path) {
        errors.push("review_file_path not populated");
      }
      if (!parsed.finding_counts) {
        errors.push("finding_counts not populated");
      } else {
        if (typeof parsed.finding_counts.p1_critical !== "number") errors.push("finding_counts.p1_critical missing");
        if (typeof parsed.finding_counts.p2_important !== "number") errors.push("finding_counts.p2_important missing");
        if (typeof parsed.finding_counts.p3_suggestion !== "number") errors.push("finding_counts.p3_suggestion missing");
      }

      return { passed: errors.length === 0, errors, warnings };
    },
  },
  {
    name: "EVALUATOR",
    description: "Evaluator writes verdict with passed, reasoning, confidence",
    buildPrompt: (hp) => {
      const instruction = renderEvaluatorHandoffInstruction(hp);
      return `You are an evaluator checking whether worker output meets acceptance criteria.

## Worker Output
The worker implemented a GET /health endpoint that returns { status: "ok" }.
Tests pass: 3/3 tests pass.
Files created: src/routes/health.ts, tests/health.test.ts.

## Validation Criteria
- GET /health endpoint exists and returns 200
- Response body is { status: "ok" }
- Tests are written and pass

${instruction}

IMPORTANT: Your ONLY deliverable is writing the JSON verdict file above. Evaluate the worker output
against the criteria and write your verdict. All fields are REQUIRED.`;
    },
    schema: EvaluatorVerdictSchema,
    validate: (parsed) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (typeof parsed.passed !== "boolean") errors.push("passed is not a boolean");
      if (!parsed.reasoning || parsed.reasoning.length < 10) errors.push("reasoning too short or missing");
      if (typeof parsed.confidence !== "number") errors.push("confidence is not a number");
      else if (parsed.confidence < 0 || parsed.confidence > 1) errors.push(`confidence out of range: ${parsed.confidence}`);
      if (!parsed.feedback) warnings.push("feedback is empty");
      if (!Array.isArray(parsed.suggestions)) errors.push("suggestions is not an array");
      if (!Array.isArray(parsed.files_to_review)) errors.push("files_to_review is not an array");

      return { passed: errors.length === 0, errors, warnings };
    },
  },
  {
    name: "DISPATCHER",
    description: "Dispatcher writes decision with schema_version=1, phase_index, task_content",
    buildPrompt: (hp) => {
      const instruction = renderDispatcherHandoffInstruction(hp);
      return `You are a dispatcher deciding what work a worker should do next.

## Plan
# Implementation Plan: Health Endpoint

### Phase 1: Add health endpoint
- [ ] Create src/routes/health.ts with GET handler returning { status: "ok" }
- [ ] Add test in tests/health.test.ts
- [ ] Register route in src/routes/index.ts

### Phase 2: Add readiness check
- [ ] Extend health endpoint with database connectivity check
- [ ] Add integration test

## Current State
Phase 1 is next. No prior work has been done.

${instruction}

IMPORTANT: Your ONLY deliverable is writing the JSON decision file above.
Dispatch Phase 1 (phase_index: 0). Include realistic task_content and context_files.
schema_version MUST be exactly 1 (the number, not a string).`;
    },
    schema: DispatcherDecisionHandoffSchema,
    validate: (parsed) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      if (parsed.schema_version !== 1) errors.push(`schema_version is ${parsed.schema_version}, expected 1`);
      if (typeof parsed.phase_index !== "number") errors.push("phase_index is not a number");
      if (!parsed.task_content || parsed.task_content.length < 10) errors.push("task_content too short or missing");
      if (!Array.isArray(parsed.context_files)) errors.push("context_files is not an array");

      if (!parsed.session_name) warnings.push("session_name not populated");
      if (!parsed.reasoning) warnings.push("reasoning not populated");

      return { passed: errors.length === 0, errors, warnings };
    },
  },
];

// ---------------------------------------------------------------------------
// Engine command builder
// ---------------------------------------------------------------------------

function buildCommand(
  engine: "claude" | "opencode",
  prompt: string,
  handoffPath: string,
): { command: string; args: string[] } {
  if (engine === "claude") {
    return {
      command: "claude",
      args: [
        "--print",
        "--no-session-persistence",
        "--allowedTools",
        "Write,Read,Bash",
        "-p",
        prompt,
      ],
    };
  } else {
    // opencode
    return {
      command: "opencode",
      args: ["run", "--format", "json", "--prompt", prompt],
    };
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: Scenario,
  engine: "claude" | "opencode",
): Promise<ScenarioResult> {
  const invocationId = generateInvocationId();
  const hp = path.join(OUTPUT_DIR, `${invocationId}-handoff.json`);
  ensureOutputDir();

  const prompt = scenario.buildPrompt(hp);

  // Save the prompt
  saveArtifact(`${scenario.name.toLowerCase()}-prompt.md`, prompt);

  info(`Scenario: ${scenario.name} — ${scenario.description}`);
  info(`Invocation: ${invocationId}`);
  info(`Handoff path: ${hp}`);
  info(`Prompt length: ${prompt.length} chars`);

  if (dryRun) {
    if (verbose) {
      console.log(`\n${BOLD}--- Prompt ---${RESET}\n`);
      console.log(prompt);
    }
    return {
      name: scenario.name,
      passed: true,
      durationMs: 0,
      errors: [],
      warnings: ["Dry run — skipped LLM call"],
    };
  }

  const { command, args: cmdArgs } = buildCommand(engine, prompt, hp);
  info(`Command: ${command} ${cmdArgs.slice(0, 3).join(" ")}...`);
  info("Spawning subprocess (may take 30-120s)...");

  const startTime = performance.now();

  try {
    const proc = Bun.spawn([command, ...cmdArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_MAX_TURNS: "3" },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const durationMs = performance.now() - startTime;

    info(`Exit code: ${exitCode} (${(durationMs / 1000).toFixed(1)}s)`);

    if (exitCode !== 0) {
      fail(`Subprocess exited with code ${exitCode}`);
      if (stderr) info(`stderr: ${stderr.slice(0, 200)}`);
      return {
        name: scenario.name,
        passed: false,
        durationMs,
        errors: [`Exit code ${exitCode}`],
        warnings: [],
      };
    }

    // Read and validate handoff file
    let parsed: any;
    try {
      parsed = await readHandoff(hp, scenario.schema);
      pass("Handoff file exists and passes schema validation");
    } catch (err) {
      if (err instanceof HandoffMissingError) {
        fail("Handoff file not written by subprocess");
        return {
          name: scenario.name,
          passed: false,
          durationMs,
          errors: ["Handoff file missing"],
          warnings: [],
        };
      }
      if (err instanceof HandoffInvalidError) {
        fail(`Handoff file invalid: ${err.message}`);
        // Try to read raw content for debugging
        try {
          const raw = fs.readFileSync(hp, "utf-8");
          saveArtifact(`${scenario.name.toLowerCase()}-raw-handoff.json`, raw);
          if (verbose) info(`Raw content: ${raw.slice(0, 500)}`);
        } catch { /* file may not exist */ }
        return {
          name: scenario.name,
          passed: false,
          durationMs,
          errors: [err.message],
          warnings: [],
        };
      }
      throw err;
    }

    // Run scenario-specific validation
    const validation = scenario.validate(parsed);

    for (const error of validation.errors) fail(error);
    for (const warning of validation.warnings) warn(warning);

    if (validation.passed) {
      pass(`${scenario.name} scenario passed`);
    } else {
      fail(`${scenario.name} scenario failed`);
    }

    // Save artifacts
    saveArtifact(
      `${scenario.name.toLowerCase()}-handoff.json`,
      JSON.stringify(parsed, null, 2),
    );
    saveArtifact(
      `${scenario.name.toLowerCase()}-timing.json`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        scenario: scenario.name,
        engine,
        durationMs: Math.round(durationMs),
        exitCode,
        passed: validation.passed,
      }, null, 2),
    );

    if (verbose) {
      console.log(`\n${BOLD}--- Handoff Content ---${RESET}\n`);
      console.log(JSON.stringify(parsed, null, 2));
    }

    return {
      name: scenario.name,
      passed: validation.passed,
      durationMs,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  } catch (err) {
    const durationMs = performance.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    fail(`Scenario ${scenario.name} threw: ${message}`);
    return {
      name: scenario.name,
      passed: false,
      durationMs,
      errors: [message],
      warnings: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}=== Handoff System Verification ===${RESET}\n`);

if (dryRun) {
  info("Dry run mode — showing prompts, skipping LLM calls");
}

// Select scenarios
let scenariosToRun = SCENARIOS;
if (scenarioArg) {
  const match = SCENARIOS.find((s) => s.name === scenarioArg);
  if (!match) {
    console.error(
      `${RED}ERROR${RESET}: Unknown scenario "${scenarioArg}". Available: ${SCENARIOS.map((s) => s.name).join(", ")}`,
    );
    process.exit(1);
  }
  scenariosToRun = [match];
}

info(`Scenarios: ${scenariosToRun.map((s) => s.name).join(", ")}`);
if (engineArg) info(`Engine: ${engineArg}`);

const startTime = performance.now();
const results: ScenarioResult[] = [];

for (const scenario of scenariosToRun) {
  console.log(`\n${BOLD}--- ${scenario.name} ---${RESET}\n`);
  const result = await runScenario(scenario, engineArg ?? "opencode");
  results.push(result);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}=== Summary ===${RESET}\n`);

const totalPassed = results.filter((r) => r.passed).length;
const totalFailed = results.filter((r) => !r.passed).length;
const totalDuration = performance.now() - startTime;

for (const r of results) {
  const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const duration = (r.durationMs / 1000).toFixed(1);
  console.log(`  ${icon} ${r.name} (${duration}s)`);
  for (const e of r.errors) console.log(`       ${RED}${e}${RESET}`);
  for (const w of r.warnings) console.log(`       ${YELLOW}${w}${RESET}`);
}

console.log();
info(`Total: ${totalPassed} passed, ${totalFailed} failed`);
info(`Duration: ${(totalDuration / 1000).toFixed(1)}s`);
info(`Artifacts: ${OUTPUT_DIR}`);

// Save summary report
saveArtifact(
  "report.json",
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      engine: engineArg ?? "auto",
      dryRun,
      results: results.map((r) => ({
        name: r.name,
        passed: r.passed,
        durationMs: Math.round(r.durationMs),
        errors: r.errors,
        warnings: r.warnings,
      })),
      summary: { passed: totalPassed, failed: totalFailed, totalMs: Math.round(totalDuration) },
    },
    null,
    2,
  ),
);

if (totalFailed > 0) {
  console.log(`\n${RED}${BOLD}Verification failed.${RESET}\n`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}${BOLD}Verification complete.${RESET}\n`);
}
