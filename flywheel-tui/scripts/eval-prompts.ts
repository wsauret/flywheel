#!/usr/bin/env bun
/**
 * eval-prompts.ts — Prompt evaluation infrastructure for dispatcher and evaluator.
 *
 * Runs 3 test scenarios (simple, complex, edge) through the dispatcher and
 * evaluator transports, then scores the outputs using an LLM-as-judge.
 *
 * Usage:
 *   bun run scripts/eval-prompts.ts --engine=claude              # run evaluation with Claude
 *   bun run scripts/eval-prompts.ts --engine=opencode            # run evaluation with OpenCode
 *   bun run scripts/eval-prompts.ts --engine=claude --baseline   # capture golden baselines
 *   bun run scripts/eval-prompts.ts --engine=claude --compare    # compare against baseline
 *   bun run scripts/eval-prompts.ts --verbose                    # show detailed output
 *   bun run scripts/eval-prompts.ts --help                       # show usage
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildAllScenarios,
  buildDispatcherJudgePrompt,
  buildEvaluatorJudgePrompt,
  calculateScoreDelta,
  calculateTimingDelta,
  type TestScenario,
  type ScenarioResult,
  type DispatcherJudgeScores,
  type EvaluatorJudgeScores,
  type EvalSummary,
} from "./eval-prompts-fixtures";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";
import type { DispatcherDecision } from "../src/schemas/dispatcher";
import { EvaluatorResultSchema } from "../src/schemas/evaluator";
import type { EvaluatorResult } from "../src/schemas/evaluator";
import { getEngine } from "../src/engines/core/registry";
import type { Engine } from "../src/engines/core/types";

// ---------------------------------------------------------------------------
// Constants / Helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const BASE_DIR = path.join(process.cwd(), ".flywheel", "eval-prompts");
const BASELINE_DIR = path.join(BASE_DIR, "baseline");

function pass(msg: string) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
function fail(msg: string, detail?: string) {
  console.log(`  ${RED}FAIL${RESET} ${msg}`);
  if (detail) console.log(`       ${DIM}${detail}${RESET}`);
}
function info(msg: string) { console.log(`  ${CYAN}INFO${RESET} ${msg}`); }

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveJson(dir: string, filename: string, data: unknown): string {
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

function loadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const baselineMode = args.includes("--baseline");
const compareMode = args.includes("--compare");
const helpFlag = args.includes("--help");
const engineArg = args.find(a => a.startsWith("--engine="))?.split("=")[1] as "claude" | "opencode" | undefined;

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

if (helpFlag) {
  console.log(`
${BOLD}eval-prompts.ts${RESET} — Prompt evaluation infrastructure for dispatcher and evaluator.

${BOLD}Usage:${RESET}
  bun run scripts/eval-prompts.ts --engine=<engine> [options]

${BOLD}Required:${RESET}
  --engine=claude|opencode   Select which engine to use for evaluation

${BOLD}Options:${RESET}
  --baseline                 Capture current results as golden baseline
  --compare                  Compare current results against saved baseline
  --verbose                  Show detailed output for each scenario
  --help                     Show this help message

${BOLD}What it does:${RESET}
  1. Runs 3 test scenarios (simple, complex, edge) through the dispatcher
  2. Runs the same scenarios through the evaluator with simulated worker output
  3. Scores each output using an LLM-as-judge (haiku model for cheapness)
  4. Saves all artifacts to .flywheel/eval-prompts/<run-id>/
  5. Prints a comparison table to stdout

${BOLD}Scenarios:${RESET}
  SIMPLE  — Single-phase plan, no context, no budget constraints
  COMPLEX — Multi-phase plan (5 phases, 2 completed), context entries, budget
  EDGE    — Truncated plan, tight budget, failed last_worker_result

${BOLD}Judge Scoring (1-5 each):${RESET}
  Dispatcher: Clarity, Completeness, Actionability
  Evaluator:  Accuracy, Thoroughness, Usefulness

${BOLD}Examples:${RESET}
  bun run scripts/eval-prompts.ts --engine=claude --baseline
  bun run scripts/eval-prompts.ts --engine=claude --compare
  bun run scripts/eval-prompts.ts --engine=opencode --verbose
`);
  process.exit(0);
}

// Validate engine arg
if (!engineArg) {
  console.error(`${RED}ERROR${RESET}: --engine=claude|opencode is required.`);
  console.error(`Run with --help for usage information.`);
  process.exit(1);
}

if (engineArg !== "claude" && engineArg !== "opencode") {
  console.error(`${RED}ERROR${RESET}: Invalid --engine value "${engineArg}". Must be "claude" or "opencode".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Engine and transport setup
// ---------------------------------------------------------------------------

let engine: Engine;
try {
  engine = getEngine(engineArg);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${RED}ERROR${RESET}: ${message}`);
  process.exit(1);
}

// Check binary availability
const binary = engine.metadata.cliBinary;
if (!Bun.which(binary)) {
  console.error(`${RED}ERROR${RESET}: ${binary} CLI not found. Install: ${engine.metadata.installCommand}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Core execution: spawn engine subprocess for a prompt
// ---------------------------------------------------------------------------

/**
 * Run a prompt through the engine and get the raw output.
 * Uses the same engine command building as SubprocessTransport.
 */
async function runEnginePrompt(
  userPrompt: string,
  systemPrompt: string,
  model?: string,
): Promise<{ output: string; timingMs: number }> {
  const engineCmd = engine.buildDispatcherCommand({
    prompt: userPrompt,
    systemPrompt,
    model,
  });

  const env = { ...process.env };

  const stdinContent = engineCmd.stdinPrompt
    ? `${systemPrompt}\n\n---\n\n${userPrompt}`
    : undefined;

  const start = performance.now();

  const proc = Bun.spawn([engineCmd.command, ...engineCmd.args], {
    stdin: stdinContent ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  if (stdinContent && proc.stdin) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdinContent));
    await writer.close();
  }

  const output = await new Response(proc.stdout).text();
  const _stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const timingMs = performance.now() - start;
  return { output, timingMs };
}

/**
 * Parse engine output to extract JSON.
 * Handles both OpenCode NDJSON and Claude Code plain text.
 */
function extractJsonFromOutput(output: string): string {
  const isOpenCode = engine.metadata.id === "opencode";

  let source = output;
  if (isOpenCode) {
    // Extract text from NDJSON
    const parts: string[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event?.type === "text" && typeof event.part?.text === "string") {
          parts.push(event.part.text);
        }
      } catch {
        // Not JSON — skip
      }
    }
    if (parts.length > 0) source = parts.join("");
  }

  return source;
}

// ---------------------------------------------------------------------------
// Dispatcher invocation
// ---------------------------------------------------------------------------

import { buildDispatcherSystemPrompt, buildTruncationNotes } from "../src/dispatcher/system-prompt";

async function runDispatcher(scenario: TestScenario): Promise<{
  timing_ms: number;
  schema_valid: boolean;
  raw_output: string;
  parsed_decision: DispatcherDecision | null;
}> {
  const systemPrompt = buildDispatcherSystemPrompt();
  const truncationNotes = buildTruncationNotes(scenario.dispatcherInput);
  const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(scenario.dispatcherInput)}\n\nRespond with valid JSON only.`;

  const { output, timingMs } = await runEnginePrompt(userContent, systemPrompt);

  const source = extractJsonFromOutput(output);
  const jsonMatch = source.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_decision: null };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result = DispatcherDecisionSchema.safeParse(parsed);
    if (result.success) {
      return { timing_ms: timingMs, schema_valid: true, raw_output: output, parsed_decision: result.data };
    }
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_decision: null };
  } catch {
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_decision: null };
  }
}

// ---------------------------------------------------------------------------
// Evaluator invocation
// ---------------------------------------------------------------------------

async function runEvaluator(scenario: TestScenario): Promise<{
  timing_ms: number;
  schema_valid: boolean;
  raw_output: string;
  parsed_result: EvaluatorResult | null;
}> {
  const EVAL_SYSTEM_PROMPT =
    "You are an evaluator checking whether worker output meets the validation criteria. " +
    "Evaluate the output against all provided criteria and respond with valid JSON only.";

  // Build the evaluator user prompt (same as SubprocessEvaluatorTransport.buildPrompt)
  const input = scenario.evaluatorInput;
  const sections: string[] = [
    "You are an evaluator checking whether worker output meets the validation criteria.",
    "",
    "## Worker Output",
    input.worker_output,
    "",
    "## Validation Criteria",
    input.evaluation_criteria,
    "",
  ];

  if (input.acceptance_criteria.length > 0) {
    sections.push("## Acceptance Criteria", ...input.acceptance_criteria.map(c => `- ${c}`), "");
  }
  if (input.artifacts_produced.length > 0) {
    sections.push("## Artifacts Produced", ...input.artifacts_produced.map(a => `- ${a}`), "");
  }
  if (input.tests_passed !== null) {
    sections.push("## Test Results", `Tests passed: ${input.tests_passed ? "yes" : "no"}`, "");
  }

  sections.push(
    "## Instructions",
    "Evaluate the worker output against the validation criteria. Respond with valid JSON only, matching this exact schema:",
    '{ "passed": boolean, "reasoning": string, "suggestions": string[], "confidence": number, "feedback": string, "files_to_review": string[] }',
    "",
    "- passed: true if the output meets all criteria, false otherwise",
    "- reasoning: string explaining your assessment of the output",
    "- suggestions: array of improvement suggestions (empty array [] if none)",
    "- confidence: float between 0.0 and 1.0 indicating how confident you are in your evaluation (NOT 0-100, must be a decimal like 0.85)",
    "- feedback: string with overall feedback about the work quality",
    "- files_to_review: array of file paths that need further review (empty array [] if none)",
  );

  const userContent = sections.join("\n");

  const { output, timingMs } = await runEnginePrompt(userContent, EVAL_SYSTEM_PROMPT);

  const source = extractJsonFromOutput(output);
  const jsonMatch = source.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_result: null };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result = EvaluatorResultSchema.safeParse(parsed);
    if (result.success) {
      return { timing_ms: timingMs, schema_valid: true, raw_output: output, parsed_result: result.data };
    }
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_result: null };
  } catch {
    return { timing_ms: timingMs, schema_valid: false, raw_output: output, parsed_result: null };
  }
}

// ---------------------------------------------------------------------------
// LLM-as-judge
// ---------------------------------------------------------------------------

/** Haiku model for cheap judge calls */
const JUDGE_MODELS: Record<string, string> = {
  claude: "haiku",
  opencode: "anthropic/claude-haiku-4-5",
};

async function runJudge<T>(prompt: string): Promise<T | null> {
  const judgeModel = JUDGE_MODELS[engineArg!];
  const systemPrompt = "You are a strict quality judge. Score outputs on the given dimensions. Output valid JSON only, no markdown.";

  try {
    const { output } = await runEnginePrompt(prompt, systemPrompt, judgeModel);
    const source = extractJsonFromOutput(output);
    const jsonMatch = source.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
}

async function judgeDispatcher(
  phaseDescription: string,
  taskContent: string,
): Promise<DispatcherJudgeScores | null> {
  const prompt = buildDispatcherJudgePrompt(phaseDescription, taskContent);
  return runJudge<DispatcherJudgeScores>(prompt);
}

async function judgeEvaluator(
  workerOutput: string,
  criteria: string,
  result: EvaluatorResult,
): Promise<EvaluatorJudgeScores | null> {
  const prompt = buildEvaluatorJudgePrompt(workerOutput, criteria, {
    passed: result.passed,
    reasoning: result.reasoning,
    confidence: result.confidence,
  });
  return runJudge<EvaluatorJudgeScores>(prompt);
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

async function runAllScenarios(): Promise<ScenarioResult[]> {
  const scenarios = buildAllScenarios();
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n${BOLD}--- Scenario: ${scenario.name.toUpperCase()} ---${RESET}`);
    info(scenario.description);

    // Run dispatcher
    info("Running dispatcher...");
    const dispResult = await runDispatcher(scenario);
    if (dispResult.schema_valid) {
      pass(`Dispatcher: schema valid, ${(dispResult.timing_ms / 1000).toFixed(1)}s`);
    } else {
      fail(`Dispatcher: schema invalid, ${(dispResult.timing_ms / 1000).toFixed(1)}s`);
    }

    // Run evaluator
    info("Running evaluator...");
    const evalResult = await runEvaluator(scenario);
    if (evalResult.schema_valid) {
      pass(`Evaluator: schema valid, ${(evalResult.timing_ms / 1000).toFixed(1)}s`);
    } else {
      fail(`Evaluator: schema invalid, ${(evalResult.timing_ms / 1000).toFixed(1)}s`);
    }

    // Run judge on dispatcher
    let dispJudge: DispatcherJudgeScores | null = null;
    if (dispResult.parsed_decision) {
      info("Running judge on dispatcher output...");
      const currentPhase = scenario.dispatcherInput.plan.phases[
        scenario.dispatcherInput.state.current_phase_index
      ];
      const phaseDesc = currentPhase
        ? `${currentPhase.name}: ${currentPhase.steps.map(s => s.description).join("; ")}`
        : "Unknown phase";
      dispJudge = await judgeDispatcher(phaseDesc, dispResult.parsed_decision.task_content);
      if (dispJudge) {
        pass(`Judge (dispatcher): C=${dispJudge.clarity} Co=${dispJudge.completeness} A=${dispJudge.actionability}`);
      } else {
        fail("Judge (dispatcher): failed to score");
      }
    }

    // Run judge on evaluator
    let evalJudge: EvaluatorJudgeScores | null = null;
    if (evalResult.parsed_result) {
      info("Running judge on evaluator output...");
      evalJudge = await judgeEvaluator(
        scenario.evaluatorInput.worker_output,
        scenario.evaluatorInput.evaluation_criteria,
        evalResult.parsed_result,
      );
      if (evalJudge) {
        pass(`Judge (evaluator): Ac=${evalJudge.accuracy} T=${evalJudge.thoroughness} U=${evalJudge.usefulness}`);
      } else {
        fail("Judge (evaluator): failed to score");
      }
    }

    results.push({
      scenario: scenario.name,
      dispatcher: {
        timing_ms: dispResult.timing_ms,
        schema_valid: dispResult.schema_valid,
        raw_output: dispResult.raw_output,
        parsed_decision: dispResult.parsed_decision,
      },
      evaluator: {
        timing_ms: evalResult.timing_ms,
        schema_valid: evalResult.schema_valid,
        raw_output: evalResult.raw_output,
        parsed_result: evalResult.parsed_result,
      },
      judge: {
        dispatcher_scores: dispJudge,
        evaluator_scores: evalJudge,
      },
    });

    if (verbose && dispResult.parsed_decision) {
      console.log(`\n  ${DIM}task_content: ${dispResult.parsed_decision.task_content.slice(0, 200)}...${RESET}`);
    }
    if (verbose && evalResult.parsed_result) {
      console.log(`  ${DIM}reasoning: ${evalResult.parsed_result.reasoning.slice(0, 200)}...${RESET}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

function printComparisonTable(results: ScenarioResult[]) {
  console.log(`\n${BOLD}=== Results Summary ===${RESET}\n`);

  // Header
  const header = [
    "Scenario".padEnd(10),
    "Disp Time".padEnd(11),
    "Eval Time".padEnd(11),
    "Disp Scores (C/Co/A)".padEnd(22),
    "Eval Scores (Ac/T/U)".padEnd(22),
    "Schema",
  ].join(" | ");
  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  for (const r of results) {
    const dispTime = `${(r.dispatcher.timing_ms / 1000).toFixed(1)}s`.padEnd(11);
    const evalTime = `${(r.evaluator.timing_ms / 1000).toFixed(1)}s`.padEnd(11);

    const dj = r.judge.dispatcher_scores;
    const ej = r.judge.evaluator_scores;
    const dispScores = dj ? `${dj.clarity}/${dj.completeness}/${dj.actionability}` : "N/A";
    const evalScores = ej ? `${ej.accuracy}/${ej.thoroughness}/${ej.usefulness}` : "N/A";

    const schemaOk = r.dispatcher.schema_valid && r.evaluator.schema_valid;
    const schemaStr = schemaOk ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;

    const row = [
      r.scenario.padEnd(10),
      dispTime,
      evalTime,
      dispScores.padEnd(22),
      evalScores.padEnd(22),
      schemaStr,
    ].join(" | ");
    console.log(`  ${row}`);
  }
}

function printBaselineDelta(
  baseline: EvalSummary,
  current: ScenarioResult[],
) {
  console.log(`\n${BOLD}=== Baseline Comparison ===${RESET}\n`);
  info(`Baseline captured: ${baseline.timestamp}`);
  info(`Baseline engine: ${baseline.engine}`);

  console.log();

  for (const cr of current) {
    const br = baseline.scenarios.find(s => s.scenario === cr.scenario);
    if (!br) {
      console.log(`  ${YELLOW}${cr.scenario}${RESET}: no baseline found`);
      continue;
    }

    console.log(`  ${BOLD}${cr.scenario.toUpperCase()}${RESET}`);

    // Timing delta
    const dispTiming = calculateTimingDelta(br.dispatcher.timing_ms, cr.dispatcher.timing_ms);
    const evalTiming = calculateTimingDelta(br.evaluator.timing_ms, cr.evaluator.timing_ms);
    const dispSign = dispTiming.improved ? GREEN + "▼" : RED + "▲";
    const evalSign = evalTiming.improved ? GREEN + "▼" : RED + "▲";
    console.log(`    Dispatcher timing: ${(cr.dispatcher.timing_ms / 1000).toFixed(1)}s (${dispSign}${Math.abs(dispTiming.absolute_ms / 1000).toFixed(1)}s${RESET})`);
    console.log(`    Evaluator timing:  ${(cr.evaluator.timing_ms / 1000).toFixed(1)}s (${evalSign}${Math.abs(evalTiming.absolute_ms / 1000).toFixed(1)}s${RESET})`);

    // Score delta
    if (br.judge.dispatcher_scores && cr.judge.dispatcher_scores) {
      const baseScores = {
        clarity: br.judge.dispatcher_scores.clarity,
        completeness: br.judge.dispatcher_scores.completeness,
        actionability: br.judge.dispatcher_scores.actionability,
      };
      const curScores = {
        clarity: cr.judge.dispatcher_scores.clarity,
        completeness: cr.judge.dispatcher_scores.completeness,
        actionability: cr.judge.dispatcher_scores.actionability,
      };
      const delta = calculateScoreDelta(baseScores, curScores);
      const formatDelta = (d: number) => d > 0 ? `${GREEN}+${d}${RESET}` : d < 0 ? `${RED}${d}${RESET}` : `${DIM}0${RESET}`;
      console.log(`    Dispatcher scores: C=${curScores.clarity}(${formatDelta(delta.clarity)}) Co=${curScores.completeness}(${formatDelta(delta.completeness)}) A=${curScores.actionability}(${formatDelta(delta.actionability)})`);
    }

    if (br.judge.evaluator_scores && cr.judge.evaluator_scores) {
      const baseScores = {
        accuracy: br.judge.evaluator_scores.accuracy,
        thoroughness: br.judge.evaluator_scores.thoroughness,
        usefulness: br.judge.evaluator_scores.usefulness,
      };
      const curScores = {
        accuracy: cr.judge.evaluator_scores.accuracy,
        thoroughness: cr.judge.evaluator_scores.thoroughness,
        usefulness: cr.judge.evaluator_scores.usefulness,
      };
      const delta = calculateScoreDelta(baseScores, curScores);
      const formatDelta = (d: number) => d > 0 ? `${GREEN}+${d}${RESET}` : d < 0 ? `${RED}${d}${RESET}` : `${DIM}0${RESET}`;
      console.log(`    Evaluator scores:  Ac=${curScores.accuracy}(${formatDelta(delta.accuracy)}) T=${curScores.thoroughness}(${formatDelta(delta.thoroughness)}) U=${curScores.usefulness}(${formatDelta(delta.usefulness)})`);
    }

    // Schema validity
    const schemaChanged = br.dispatcher.schema_valid !== cr.dispatcher.schema_valid ||
                          br.evaluator.schema_valid !== cr.evaluator.schema_valid;
    if (schemaChanged) {
      console.log(`    ${RED}Schema validity changed!${RESET}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}=== Prompt Evaluation: ${engineArg} ===${RESET}\n`);
info(`Engine: ${engineArg}`);
info(`Mode: ${baselineMode ? "baseline capture" : compareMode ? "compare with baseline" : "evaluation"}`);

const startTime = performance.now();
const results = await runAllScenarios();
const totalElapsed = performance.now() - startTime;

// Print comparison table
printComparisonTable(results);

// Save artifacts
const runId = baselineMode ? "baseline" : new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(BASE_DIR, runId);

const summary: EvalSummary = {
  run_id: runId,
  timestamp: new Date().toISOString(),
  engine: engineArg,
  scenarios: results,
};

const scenarios = buildAllScenarios();
saveJson(outputDir, "scenarios.json", scenarios.map(s => ({
  name: s.name,
  description: s.description,
  dispatcherInput: s.dispatcherInput,
  evaluatorInput: s.evaluatorInput,
})));

saveJson(outputDir, "dispatcher-results.json", results.map(r => ({
  scenario: r.scenario,
  timing_ms: r.dispatcher.timing_ms,
  schema_valid: r.dispatcher.schema_valid,
  parsed_decision: r.dispatcher.parsed_decision,
})));

saveJson(outputDir, "evaluator-results.json", results.map(r => ({
  scenario: r.scenario,
  timing_ms: r.evaluator.timing_ms,
  schema_valid: r.evaluator.schema_valid,
  parsed_result: r.evaluator.parsed_result,
})));

saveJson(outputDir, "judge-scores.json", results.map(r => ({
  scenario: r.scenario,
  dispatcher_scores: r.judge.dispatcher_scores,
  evaluator_scores: r.judge.evaluator_scores,
})));

saveJson(outputDir, "summary.json", summary);

info(`Artifacts saved to ${outputDir}`);

// Baseline mode: also save to baseline/
if (baselineMode) {
  console.log(`\n${BOLD}--- Baseline Captured ---${RESET}\n`);
  info(`Golden baselines saved to ${BASELINE_DIR}`);
  pass("Baseline artifacts ready for --compare mode");
}

// Compare mode: load baseline and print delta
if (compareMode) {
  const baselineSummary = loadJson<EvalSummary>(path.join(BASELINE_DIR, "summary.json"));
  if (!baselineSummary) {
    fail("No baseline found. Run with --baseline first.");
    process.exit(1);
  }
  printBaselineDelta(baselineSummary, results);
}

// Final summary
console.log(`\n${BOLD}--- Final ---${RESET}\n`);
info(`Total time: ${(totalElapsed / 1000).toFixed(1)}s`);
info(`Scenarios run: ${results.length}`);
const allSchemaValid = results.every(r => r.dispatcher.schema_valid && r.evaluator.schema_valid);
if (allSchemaValid) {
  pass("All schema validations passed");
} else {
  fail("Some schema validations failed");
}

const allJudged = results.every(r => r.judge.dispatcher_scores && r.judge.evaluator_scores);
if (allJudged) {
  pass("All judge scores obtained");
} else {
  fail("Some judge scores missing (LLM judge may have failed)");
}

console.log(`\n${GREEN}${BOLD}Evaluation complete.${RESET}\n`);
