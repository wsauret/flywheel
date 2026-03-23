#!/usr/bin/env bun
/**
 * verify-dispatcher.ts — end-to-end verification of the dispatcher pipeline.
 *
 * Invokes the real dispatcher transport with a minimal plan, validates the
 * response schema, and prints a detailed report. Use this to prove that:
 *
 * 1. The dispatcher returns `task_content` (not `prompt`)
 * 2. The response passes DispatcherDecisionSchema validation
 * 3. The execution loop composition works (template + task_content + enrichment)
 *
 * Saves the raw response and composed prompt to .flywheel/verify-dispatcher/
 * for post-hoc investigation.
 *
 * Usage:
 *   bun scripts/verify-dispatcher.ts                    # auto-detect transport
 *   bun scripts/verify-dispatcher.ts --transport=cli    # force subprocess
 *   bun scripts/verify-dispatcher.ts --transport=sdk    # force SDK
 *   bun scripts/verify-dispatcher.ts --verbose          # show full response
 *   bun scripts/verify-dispatcher.ts --dry-run          # show assembled input, skip LLM call
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { assembleDispatcherInput } from "../src/dispatcher/assemble";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";
import type { DispatcherDecision } from "../src/schemas/dispatcher";
import { buildDispatcherSystemPrompt } from "../src/dispatcher/system-prompt";
import { buildWorkPhasePrompt } from "../src/prompts/work/phase-prompt";
import { enrichPromptWithContext } from "../src/controller/context-enrichment";
import { wrapCompletionInstruction } from "../src/worker/completion";
import type { WorkflowStepContext } from "../src/prompts/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pass(msg: string) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
function fail(msg: string, detail?: string) {
  console.log(`  ${RED}FAIL${RESET} ${msg}`);
  if (detail) console.log(`       ${DIM}${detail}${RESET}`);
}
function info(msg: string) { console.log(`  ${CYAN}INFO${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}WARN${RESET} ${msg}`); }

// Output directory for saved artifacts
const OUTPUT_DIR = path.join(process.cwd(), ".flywheel", "verify-dispatcher");
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
const transportArg = args.find(a => a.startsWith("--transport="))?.split("=")[1] as "sdk" | "cli" | undefined;

// ---------------------------------------------------------------------------
// Test plan — minimal, realistic
// ---------------------------------------------------------------------------

const TEST_PLAN = `# Implementation Plan: Hello World Endpoint

## Overview
Add a simple GET /hello endpoint that returns { message: "hello world" }.

### Phase 1: Add endpoint and test

- [ ] Create src/routes/hello.ts with GET handler returning { message: "hello world" }
- [ ] Add test in tests/hello.test.ts verifying the endpoint returns 200 and expected body
- [ ] Register the route in src/routes/index.ts
`;

const TEST_STATE = `---
plan: hello-endpoint.md
status: in_progress
schema_version: 3
---

# Execution State: Hello World Endpoint

## Progress
- [ ] Phase 1: Add endpoint and test

## Key Decisions

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

// ---------------------------------------------------------------------------
// 1. Assemble dispatcher input
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}=== Dispatcher Verification ===${RESET}\n`);

const assembled = assembleDispatcherInput({
  planContent: TEST_PLAN,
  stateContent: TEST_STATE,
  workflowContext: {
    workflowId: "verify-dispatcher-001",
    name: "work",
    stepNumber: 1,
    totalSteps: 1,
    stepDescription: "Add endpoint and test",
  },
  configContext: {
    maxEvalCycles: 3,
    worktreePath: "",
    projectCwd: process.cwd(),
    workerModel: "opus",
    dispatcherModel: "sonnet",
  },
  sessionBudget: {
    invocations_remaining: 10,
    token_budget_remaining: null,
    wall_clock_deadline: null,
  },
  availableContext: {
    conventions: [],
    standards: [],
    learnings: [],
  },
});

info(`Assembled input: ${JSON.stringify(assembled.input).length} bytes`);
info(`Plan phases: ${assembled.input.plan.phases.length}`);
info(`Current phase: ${assembled.input.state.current_phase_index}`);

if (dryRun) {
  console.log(`\n${BOLD}--- Assembled Input (dry-run) ---${RESET}\n`);
  const inputJson = JSON.stringify(assembled.input, null, 2);
  console.log(inputJson);
  const savedInput = saveArtifact("input.json", inputJson);
  info(`Saved assembled input to ${savedInput}`);

  console.log(`\n${BOLD}--- System Prompt ---${RESET}\n`);
  const sp = buildDispatcherSystemPrompt();
  console.log(sp.slice(0, 500) + "...");
  info(`System prompt length: ${sp.length} chars`);
  const savedPrompt = saveArtifact("system-prompt.md", sp);
  info(`Saved system prompt to ${savedPrompt}`);

  console.log(`\n${YELLOW}Dry run — skipping LLM call.${RESET}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Invoke the real dispatcher
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 1: Invoke Dispatcher ---${RESET}\n`);

let decision: DispatcherDecision;
let transportLabel: string;
const startTime = performance.now();

try {
  // Dynamic import to handle optional SDK dependency
  const { autoDetectTransport } = await import("../src/dispatcher/auto-detect");
  const { BunProcessSpawner } = await import("../src/worker/bun-spawner");

  const spawner = new BunProcessSpawner();

  let resolved;
  if (transportArg === "sdk") {
    const { SdkTransport, SDK_AVAILABLE } = await import("../src/dispatcher/sdk-transport");
    if (!SDK_AVAILABLE) {
      fail("SDK not available — install @opencode-ai/sdk");
      process.exit(1);
    }
    // Check for existing server on port 4096 (started by OpenCode/TUI)
    const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
    info(`SDK baseUrl: ${baseUrl}`);
    resolved = { transport: new SdkTransport({ baseUrl }), label: "sdk" as const, dispose: () => {} };
  } else if (transportArg === "cli") {
    const { SubprocessTransport } = await import("../src/dispatcher/subprocess-transport");
    resolved = { transport: new SubprocessTransport({ spawner }), label: "cli" as const, dispose: () => {} };
  } else {
    // Auto-detect: try SDK with existing server first, then fall back to CLI
    const { SdkTransport, SDK_AVAILABLE } = await import("../src/dispatcher/sdk-transport");
    if (SDK_AVAILABLE) {
      // Check if there's an existing OpenCode server (e.g. from a running OpenCode session)
      const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
      try {
        const healthCheck = await fetch(`${baseUrl}/session`, { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) });
        if (healthCheck.ok || healthCheck.status < 500) {
          info(`Found existing OpenCode server at ${baseUrl}`);
          resolved = { transport: new SdkTransport({ baseUrl }), label: "sdk" as const, dispose: () => {} };
        }
      } catch {
        // Server not reachable, try auto-detect (which starts its own)
      }
    }
    if (!resolved) {
      resolved = await autoDetectTransport({ spawner });
    }
  }

  transportLabel = resolved.label;
  info(`Transport: ${resolved.label}`);
  info("Calling dispatcher (this may take 30-120s)...");

  decision = await resolved.transport.invoke(assembled.input);
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  pass(`Dispatcher returned in ${elapsed}s`);

  // Clean up
  resolved.dispose();
} catch (err) {
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  fail(`Dispatcher call failed after ${elapsed}s`, err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Save raw response
// ---------------------------------------------------------------------------

const savedDecision = saveArtifact("decision.json", JSON.stringify(decision, null, 2));
info(`Saved raw decision to ${savedDecision}`);

// ---------------------------------------------------------------------------
// 4. Validate schema
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 2: Schema Validation ---${RESET}\n`);

const parseResult = DispatcherDecisionSchema.safeParse(decision);
if (parseResult.success) {
  pass("DispatcherDecisionSchema.safeParse() succeeded");
} else {
  fail("DispatcherDecisionSchema.safeParse() failed", parseResult.error.message);
  process.exit(1);
}

// Check critical field: task_content exists and is non-empty
if (typeof decision.task_content === "string" && decision.task_content.length > 0) {
  pass(`task_content present (${decision.task_content.length} chars)`);
} else {
  fail("task_content missing or empty");
  process.exit(1);
}

// Check that `prompt` field does NOT exist (old schema)
if ("prompt" in (decision as any)) {
  warn("'prompt' field still present in response (stripped by .strip() but LLM sent it)");
} else {
  pass("No 'prompt' field in response (clean schema)");
}

// Check other fields
if (decision.schema_version === 1) pass("schema_version = 1");
else fail(`schema_version = ${decision.schema_version} (expected 1)`);

if (decision.phase_index === 0) pass("phase_index = 0");
else warn(`phase_index = ${decision.phase_index} (expected 0)`);

if (decision.context_files.length >= 0) pass(`context_files: ${decision.context_files.length} entries`);
if (decision.session_name) pass(`session_name: "${decision.session_name}"`);
else warn("No session_name returned (expected on first phase)");

if (decision.reasoning) pass(`reasoning present (${decision.reasoning.length} chars)`);
else warn("No reasoning returned");

if (decision.worker_config) pass("worker_config present");
else info("No worker_config override (using defaults)");

// ---------------------------------------------------------------------------
// 5. Compose: template + task_content (simulate execution loop)
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 3: Template Composition ---${RESET}\n`);

// Resolve plan content (same logic as execution loop)
const resolvedPlanContent = (decision.task_content && decision.task_content.trim())
  ? decision.task_content
  : "Add endpoint and test (fallback)";

info(`resolvedPlanContent source: ${resolvedPlanContent === decision.task_content ? "dispatcher task_content" : "FALLBACK"}`);

// Build context (same as execution loop)
const ctx: WorkflowStepContext = {
  planContent: resolvedPlanContent,
  keyDecisions: [],
  fileReferences: [],
  previousResult: undefined,
  projectCwd: process.cwd(),
  extra: {
    conventions: [],
    standards: [],
    learnings: [],
  },
};

// Template ALWAYS runs
const templateOutput = buildWorkPhasePrompt(ctx);
pass(`Template rendered (${templateOutput.length} chars)`);

// Verify template contains behavioral instructions
const hasTDD = templateOutput.includes("TDD Cycle");
const hasVerify = templateOutput.includes("Verification Protocol");
const hasUAV = templateOutput.includes("Understand-Act-Verify");
const hasTask = templateOutput.includes(resolvedPlanContent.slice(0, 50));

if (hasTDD) pass("Template includes TDD Cycle");
else fail("Template missing TDD Cycle");

if (hasVerify) pass("Template includes Verification Protocol");
else fail("Template missing Verification Protocol");

if (hasUAV) pass("Template includes Understand-Act-Verify");
else fail("Template missing Understand-Act-Verify");

if (hasTask) pass("Template includes dispatcher's task_content");
else fail("Template does NOT include dispatcher's task_content");

// Check that task_content does NOT contain behavioral instructions
// (dispatcher should focus on WHAT, not HOW)
const taskHasTDD = decision.task_content.includes("TDD Cycle");
const taskHasUAV = decision.task_content.includes("Understand-Act-Verify");
if (!taskHasTDD && !taskHasUAV) {
  pass("task_content does NOT contain behavioral instructions (good separation)");
} else {
  warn("task_content contains behavioral instructions — dispatcher should focus on WHAT, not HOW");
  if (taskHasTDD) warn("  - Contains 'TDD Cycle'");
  if (taskHasUAV) warn("  - Contains 'Understand-Act-Verify'");
}

// Wrap completion instruction
const finalPrompt = wrapCompletionInstruction(templateOutput);
if (finalPrompt.includes("<promise>COMPLETE</promise>")) {
  pass("Completion instruction applied");
} else {
  fail("Completion instruction missing");
}

info(`Final composed prompt: ${finalPrompt.length} chars`);

// Save composed artifacts
const savedTaskContent = saveArtifact("task-content.md", decision.task_content);
const savedComposed = saveArtifact("composed-prompt.md", finalPrompt);
info(`Saved task_content to ${savedTaskContent}`);
info(`Saved composed prompt to ${savedComposed}`);

// ---------------------------------------------------------------------------
// 6. Summary
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Summary ---${RESET}\n`);

const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
info(`Total time: ${totalElapsed}s`);
info(`Transport: ${transportLabel!}`);
info(`task_content length: ${decision.task_content.length} chars`);
info(`Template output length: ${templateOutput.length} chars`);
info(`Final prompt length: ${finalPrompt.length} chars`);
info(`Artifacts saved to: ${OUTPUT_DIR}`);

if (verbose) {
  console.log(`\n${BOLD}--- task_content (full) ---${RESET}\n`);
  console.log(decision.task_content);
  console.log(`\n${BOLD}--- Final composed prompt (first 2000 chars) ---${RESET}\n`);
  console.log(finalPrompt.slice(0, 2000));
  if (finalPrompt.length > 2000) console.log(`\n${DIM}... truncated (${finalPrompt.length} total chars)${RESET}`);
}

console.log(`\n${GREEN}${BOLD}Verification complete.${RESET}\n`);
