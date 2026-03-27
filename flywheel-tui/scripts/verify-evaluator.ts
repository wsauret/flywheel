#!/usr/bin/env bun
/**
 * verify-evaluator.ts — end-to-end verification of the evaluator transport.
 *
 * Invokes the real evaluator transport with a realistic worker output sample,
 * validates the response schema, and prints a detailed report. Use this to
 * prove that:
 *
 * 1. The evaluator returns a valid EvaluatorResult (passed, reasoning, etc.)
 * 2. The response passes EvaluatorResultSchema validation
 * 3. The engine-aware transport correctly spawns the selected engine
 *
 * Saves the raw response and timing data to .flywheel/verify-evaluator/
 * for post-hoc investigation.
 *
 * Usage:
 *   bun scripts/verify-evaluator.ts                              # auto-detect engine
 *   bun scripts/verify-evaluator.ts --engine=claude               # use Claude Code engine
 *   bun scripts/verify-evaluator.ts --engine=opencode             # use OpenCode engine
 *   bun scripts/verify-evaluator.ts --verbose                     # show full response
 *   bun scripts/verify-evaluator.ts --dry-run                     # show assembled input, skip LLM call
 *   bun scripts/verify-evaluator.ts --help                        # show usage
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EvaluatorResultSchema } from "../src/schemas/evaluator";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";

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
const OUTPUT_DIR = path.join(process.cwd(), ".flywheel", "verify-evaluator");
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
const engineArg = args.find(a => a.startsWith("--engine="))?.split("=")[1] as "claude" | "opencode" | undefined;

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

if (helpFlag) {
  console.log(`
${BOLD}verify-evaluator.ts${RESET} — end-to-end verification of the evaluator transport.

${BOLD}Usage:${RESET}
  bun scripts/verify-evaluator.ts [options]

${BOLD}Options:${RESET}
  --engine=claude|opencode   Select which engine to test (default: auto-detect)
  --verbose                  Show full evaluator response details
  --dry-run                  Assemble input and show it, skip the LLM call
  --help                     Show this help message

${BOLD}Engine Selection:${RESET}
  --engine=claude    Use Claude Code CLI (subprocess transport)
  --engine=opencode  Use OpenCode CLI (subprocess transport)
  (omitted)          Auto-detect based on available engines

${BOLD}Examples:${RESET}
  bun scripts/verify-evaluator.ts --engine=claude --verbose
  bun scripts/verify-evaluator.ts --engine=opencode
  bun scripts/verify-evaluator.ts --dry-run

${BOLD}Artifacts:${RESET}
  Results are saved to .flywheel/verify-evaluator/ including:
  - result.json       Raw EvaluatorResult response
  - timing.json       Wall-clock timing data
  - input.json        Assembled evaluator input
`);
  process.exit(0);
}

// Validate --engine flag
if (engineArg && engineArg !== "claude" && engineArg !== "opencode") {
  console.error(`${RED}ERROR${RESET}: Invalid --engine value "${engineArg}". Must be "claude" or "opencode".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Realistic evaluator input — simulated worker output from a code generation task
// ---------------------------------------------------------------------------

const SAMPLE_WORKER_OUTPUT = `## Implementation Complete

I've implemented the GET /hello endpoint as requested.

### Changes Made

1. **Created \`src/routes/hello.ts\`**
   \`\`\`typescript
   import { Hono } from "hono";

   const app = new Hono();

   app.get("/hello", (c) => {
     return c.json({ message: "hello world" });
   });

   export default app;
   \`\`\`

2. **Added test in \`tests/hello.test.ts\`**
   \`\`\`typescript
   import { describe, it, expect } from "bun:test";
   import app from "../src/routes/hello";

   describe("GET /hello", () => {
     it("returns 200 with correct body", async () => {
       const res = await app.request("/hello");
       expect(res.status).toBe(200);
       const body = await res.json();
       expect(body).toEqual({ message: "hello world" });
     });

     it("returns application/json content type", async () => {
       const res = await app.request("/hello");
       expect(res.headers.get("content-type")).toContain("application/json");
     });
   });
   \`\`\`

3. **Registered route in \`src/routes/index.ts\`** — added import and mount for the hello route.

### Test Results
\`\`\`
bun test v1.3.6
tests/hello.test.ts:
(pass) GET /hello > returns 200 with correct body [1.2ms]
(pass) GET /hello > returns application/json content type [0.3ms]

 2 pass, 0 fail
\`\`\`

### Files Modified
- \`src/routes/hello.ts\` (new — 12 lines)
- \`tests/hello.test.ts\` (new — 18 lines)
- \`src/routes/index.ts\` (modified — added 2 lines)
`;

const SAMPLE_VALIDATION_CRITERIA =
  "Acceptance criteria:\n" +
  "- GET /hello endpoint exists and returns 200\n" +
  "- Response body is { message: \"hello world\" }\n" +
  "- Tests are written and pass\n" +
  "Required: tests must pass\n" +
  "Required outputs:\n" +
  "- src/routes/hello.ts\n" +
  "- tests/hello.test.ts";

const SAMPLE_ACCEPTANCE_CRITERIA = [
  "GET /hello endpoint exists and returns 200",
  "Response body is { message: \"hello world\" }",
  "Tests are written and pass",
];

const SAMPLE_ARTIFACTS = [
  "src/routes/hello.ts",
  "tests/hello.test.ts",
  "src/routes/index.ts",
];

const SAMPLE_CONTEXT_FILES = [
  "src/routes/index.ts",
];

// ---------------------------------------------------------------------------
// Assemble evaluator input
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}=== Evaluator Verification ===${RESET}\n`);

if (engineArg) {
  info(`Engine: ${engineArg} (from --engine flag)`);
} else {
  info("Engine: auto-detect (no --engine flag)");
}

const evaluatorInput: EvaluatorInput = {
  worker_output: SAMPLE_WORKER_OUTPUT,
  evaluation_criteria: SAMPLE_VALIDATION_CRITERIA,
  context_files: SAMPLE_CONTEXT_FILES,
  acceptance_criteria: SAMPLE_ACCEPTANCE_CRITERIA,
  artifacts_produced: SAMPLE_ARTIFACTS,
  tests_passed: true,
  duration_seconds: 45,
};

info(`Assembled input: ${JSON.stringify(evaluatorInput).length} bytes`);
info(`Worker output: ${evaluatorInput.worker_output.length} chars`);
info(`Acceptance criteria: ${evaluatorInput.acceptance_criteria.length} items`);
info(`Artifacts produced: ${evaluatorInput.artifacts_produced.length} items`);

if (dryRun) {
  console.log(`\n${BOLD}--- Assembled Input (dry-run) ---${RESET}\n`);
  const inputJson = JSON.stringify(evaluatorInput, null, 2);
  console.log(inputJson);
  const savedInput = saveArtifact("input.json", inputJson);
  info(`Saved assembled input to ${savedInput}`);
  console.log(`\n${YELLOW}Dry run — skipping LLM call.${RESET}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Invoke the real evaluator transport
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 1: Invoke Evaluator ---${RESET}\n`);

let result: EvaluatorResult;
let evaluatorTimingMs: number;
const startTime = performance.now();

try {
  const { BunProcessSpawner } = await import("../src/worker/bun-spawner");
  const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");

  const spawner = new BunProcessSpawner();

  // Determine engine to use
  let resolvedEngine: string;
  if (engineArg) {
    resolvedEngine = engineArg;
  } else {
    // Auto-detect: prefer claude, fall back to opencode
    const claudeAvailable = Bun.which("claude") !== null;
    const opencodeAvailable = Bun.which("opencode") !== null;
    if (claudeAvailable) {
      resolvedEngine = "claude";
    } else if (opencodeAvailable) {
      resolvedEngine = "opencode";
    } else {
      fail("No engine binary found");
      info("Install Claude Code (npm install -g @anthropic-ai/claude-code) or OpenCode CLI");
      process.exit(1);
    }
    info(`Auto-detected engine: ${resolvedEngine}`);
  }

  let transport: SubprocessEvaluatorTransport;
  try {
    transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: resolvedEngine,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Engine not available: ${message}`);
    info("Install the engine CLI or use a different --engine flag.");
    process.exit(1);
  }

  info(`Transport: subprocess (${resolvedEngine})`);
  info("Calling evaluator (this may take 10-30s)...");

  const invokeStart = performance.now();
  result = await transport.invoke(evaluatorInput);
  evaluatorTimingMs = performance.now() - invokeStart;
  const elapsed = (evaluatorTimingMs / 1000).toFixed(1);

  console.log(`\n  ${GREEN}${BOLD}Evaluator responded in ${elapsed}s${RESET}\n`);

} catch (err) {
  evaluatorTimingMs = performance.now() - startTime;
  const elapsed = (evaluatorTimingMs / 1000).toFixed(1);
  const message = err instanceof Error ? err.message : String(err);

  // Check if this is a missing binary error for graceful reporting
  if (message.includes("CLI not found") || message.includes("not found")) {
    fail(`Engine binary not available (${elapsed}s)`);
    info(message);
    info("Install the required engine CLI or use --engine to select a different engine.");
  } else {
    fail(`Evaluator call failed after ${elapsed}s`, message);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Save raw response + timing data
// ---------------------------------------------------------------------------

const savedResult = saveArtifact("result.json", JSON.stringify(result, null, 2));
info(`Saved raw result to ${savedResult}`);

const savedInput = saveArtifact("input.json", JSON.stringify(evaluatorInput, null, 2));
info(`Saved evaluator input to ${savedInput}`);

// Save timing data
const timingData = {
  timestamp: new Date().toISOString(),
  engine: engineArg ?? "auto-detect",
  evaluator_response_ms: Math.round(evaluatorTimingMs),
  evaluator_response_s: parseFloat((evaluatorTimingMs / 1000).toFixed(1)),
  under_30s: evaluatorTimingMs < 30_000,
  passed: result.passed,
  confidence: result.confidence,
};
const savedTiming = saveArtifact("timing.json", JSON.stringify(timingData, null, 2));
info(`Saved timing data to ${savedTiming}`);

// ---------------------------------------------------------------------------
// Validate schema
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 2: Schema Validation ---${RESET}\n`);

const parseResult = EvaluatorResultSchema.safeParse(result);
if (parseResult.success) {
  pass("EvaluatorResultSchema.safeParse() succeeded");
} else {
  fail("EvaluatorResultSchema.safeParse() failed", parseResult.error.message);
  process.exit(1);
}

// Check critical fields
if (typeof result.passed === "boolean") {
  pass(`passed: ${result.passed}`);
} else {
  fail("'passed' field missing or not a boolean");
}

if (typeof result.reasoning === "string" && result.reasoning.length > 0) {
  pass(`reasoning present (${result.reasoning.length} chars)`);
} else {
  fail("reasoning missing or empty");
}

if (typeof result.confidence === "number" && result.confidence >= 0 && result.confidence <= 1) {
  pass(`confidence: ${result.confidence}`);
} else {
  fail(`confidence invalid: ${result.confidence} (expected 0-1)`);
}

if (typeof result.feedback === "string" && result.feedback.length > 0) {
  pass(`feedback present (${result.feedback.length} chars)`);
} else {
  fail("feedback missing or empty");
}

if (Array.isArray(result.files_to_review)) {
  pass(`files_to_review: ${result.files_to_review.length} entries`);
} else {
  fail("files_to_review missing or not an array");
}

if (result.suggestions && result.suggestions.length > 0) {
  info(`suggestions: ${result.suggestions.length} items`);
} else {
  info("No suggestions returned (expected for passing evaluation)");
}

// ---------------------------------------------------------------------------
// Evaluate the evaluation quality
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Step 3: Evaluation Quality ---${RESET}\n`);

// For our realistic test input (tests pass, all criteria met), we expect passed: true
if (result.passed) {
  pass("Evaluator correctly determined worker output meets criteria");
} else {
  warn("Evaluator determined output does NOT meet criteria — review reasoning");
  if (result.suggestions) {
    for (const s of result.suggestions) {
      warn(`  Suggestion: ${s}`);
    }
  }
}

// Check reasoning is substantive (not just "ok" or empty)
if (result.reasoning.length > 20) {
  pass("Reasoning is substantive (more than 20 chars)");
} else {
  warn("Reasoning is very short — may not be meaningful");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Summary ---${RESET}\n`);

const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
const evaluatorElapsed = (evaluatorTimingMs / 1000).toFixed(1);
info(`Evaluator wall-clock time: ${evaluatorElapsed}s${evaluatorTimingMs < 30_000 ? ` ${GREEN}(under 30s target)${RESET}` : ` ${YELLOW}(exceeds 30s target)${RESET}`}`);
info(`Total script time: ${totalElapsed}s`);
info(`Engine: ${engineArg ?? "auto-detect"}`);
info(`Result: ${result.passed ? "PASSED" : "FAILED"}`);
info(`Confidence: ${result.confidence}`);
info(`Reasoning: ${result.reasoning.slice(0, 100)}${result.reasoning.length > 100 ? "..." : ""}`);
info(`Artifacts saved to: ${OUTPUT_DIR}`);

if (verbose) {
  console.log(`\n${BOLD}--- Full Result ---${RESET}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n${BOLD}--- Full Reasoning ---${RESET}\n`);
  console.log(result.reasoning);
  if (result.suggestions && result.suggestions.length > 0) {
    console.log(`\n${BOLD}--- Suggestions ---${RESET}\n`);
    for (const s of result.suggestions) {
      console.log(`  - ${s}`);
    }
  }
}

console.log(`\n${GREEN}${BOLD}Verification complete.${RESET}\n`);
