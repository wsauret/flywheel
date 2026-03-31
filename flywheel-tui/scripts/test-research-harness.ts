#!/usr/bin/env bun
/**
 * test-research-harness.ts — Runs real research phases and validates output quality.
 *
 * Spawns actual Claude/OpenCode workers to execute research prompts, captures
 * output, and validates against the research output validator.
 *
 * ⚠️  WARNING: This script makes REAL API calls (spawning Claude/OpenCode workers).
 *    Each research phase takes 2-5 minutes and incurs API costs.
 *
 * Usage:
 *   bun run scripts/test-research-harness.ts --mode plan --description '<text>' --cwd <path>
 *   bun run scripts/test-research-harness.ts --mode standalone --topic '<text>' --cwd <path>
 *   bun run scripts/test-research-harness.ts --help
 *
 * Options:
 *   --mode plan|standalone    Research mode (required)
 *   --description '<text>'    Research description (plan mode)
 *   --topic '<text>'          Research topic (standalone mode)
 *   --cwd <path>              Working directory for research (required)
 *   --engine claude|opencode  Engine to use (default: claude)
 *   --output <path>           Custom output file path
 *   --skip-validation         Skip validator (just capture output)
 *   --verbose                 Show worker output in real time
 *   --help                    Show usage
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildWorkflowPrompt } from "../src/workflows/prompt-builder";
import { researchWorkflow } from "../src/workflows/research";
import { planWorkflow } from "../src/workflows/plan";
import { getEngine } from "../src/engines/core/registry";
import { BunProcessSpawner } from "../src/worker/bun-spawner";
import { TieredBuffer } from "../src/worker/buffer";
import { NDJSONParser } from "../src/worker/ndjson-parser";
import {
  validateResearchOutput,
  type ValidationResult,
  type ResearchVariant,
} from "./validate-research-output";

// ---------------------------------------------------------------------------
// ANSI helpers
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

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
${BOLD}test-research-harness.ts${RESET} — Run real research phases and validate output quality.

${YELLOW}⚠️  WARNING: This script makes REAL API calls (spawning Claude/OpenCode workers).${RESET}
${YELLOW}   Each research phase takes 2-5 minutes and incurs API costs.${RESET}

${BOLD}Usage:${RESET}
  bun run scripts/test-research-harness.ts --mode plan --description '<text>' --cwd <path>
  bun run scripts/test-research-harness.ts --mode standalone --topic '<text>' --cwd <path>

${BOLD}Options:${RESET}
  --mode plan|standalone    Research mode (required)
  --description '<text>'    Research description (plan mode)
  --topic '<text>'          Research topic (standalone mode)
  --cwd <path>              Working directory for research (required)
  --engine claude|opencode  Engine to use (default: claude)
  --output <path>           Custom output file path
  --skip-validation         Skip validator (just capture output)
  --verbose                 Show worker output in real time
  --help                    Show usage

${BOLD}Modes:${RESET}
  plan        Runs plan step 0 only (combined locate+analyze research).
              Produces .context.md style output.
  standalone  Runs all 3 standalone research steps (locate → analyze → persist).
              Produces full research document.

${BOLD}Examples:${RESET}
  bun run scripts/test-research-harness.ts --mode plan \\
    --description 'How does the core module interact with utils?' \\
    --cwd tests/fixtures/research-target/

  bun run scripts/test-research-harness.ts --mode plan \\
    --description 'How does the event bus work?' --cwd .

  bun run scripts/test-research-harness.ts --mode standalone \\
    --topic 'How does the dispatcher assemble prompts?' --cwd .
`);
}

interface CliArgs {
  mode: "plan" | "standalone";
  description?: string;
  topic?: string;
  cwd: string;
  engine: string;
  outputPath?: string;
  skipValidation: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs | null {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    printUsage();
    return null;
  }

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  const mode = getArg("--mode") as "plan" | "standalone" | undefined;
  if (!mode || (mode !== "plan" && mode !== "standalone")) {
    console.error(`${RED}ERROR${RESET}: --mode must be "plan" or "standalone".`);
    process.exit(1);
  }

  const description = getArg("--description");
  const topic = getArg("--topic");
  const cwd = getArg("--cwd");
  const engine = getArg("--engine") ?? "claude";
  const outputPath = getArg("--output");
  const skipValidation = args.includes("--skip-validation");
  const verbose = args.includes("--verbose");

  if (!cwd) {
    console.error(`${RED}ERROR${RESET}: --cwd is required.`);
    process.exit(1);
  }

  if (mode === "plan" && !description) {
    console.error(`${RED}ERROR${RESET}: --description is required in plan mode.`);
    process.exit(1);
  }

  if (mode === "standalone" && !topic) {
    console.error(`${RED}ERROR${RESET}: --topic is required in standalone mode.`);
    process.exit(1);
  }

  return { mode, description, topic, cwd, engine, outputPath, skipValidation, verbose };
}

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

/**
 * Extract meaningful research content from worker output.
 *
 * Workers may produce NDJSON or plain text. For research output, the actual
 * document is typically written to a file by the worker. But we also capture
 * the worker's conversation output in case the document is embedded there.
 *
 * Strategy:
 * 1. Look for file written by the worker (.context.md or docs/research/*.md)
 * 2. If not found, extract text content from the worker output buffer
 * 3. For plan mode: look for YAML frontmatter + section headings in output
 * 4. For standalone mode: look for the persisted file in docs/research/
 */
function extractResearchDocument(
  workerOutput: string,
  mode: "plan" | "standalone",
  cwd: string,
  description?: string,
): { content: string; source: string } {
  const absCwd = path.resolve(cwd);

  if (mode === "plan") {
    // Look for .context.md files written by the worker
    const files = findContextFiles(absCwd);
    if (files.length > 0) {
      // Use the most recently modified one
      const sorted = files.sort((a, b) => {
        const statA = fs.statSync(a);
        const statB = fs.statSync(b);
        return statB.mtimeMs - statA.mtimeMs;
      });
      const content = fs.readFileSync(sorted[0], "utf-8");
      if (content.trim().length > 100) {
        return { content, source: `file:${sorted[0]}` };
      }
    }
  }

  if (mode === "standalone") {
    // Look for docs/research/*.md files
    const researchDir = path.join(absCwd, "docs", "research");
    if (fs.existsSync(researchDir)) {
      const files = fs.readdirSync(researchDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(researchDir, f));

      if (files.length > 0) {
        const sorted = files.sort((a, b) => {
          const statA = fs.statSync(a);
          const statB = fs.statSync(b);
          return statB.mtimeMs - statA.mtimeMs;
        });
        const content = fs.readFileSync(sorted[0], "utf-8");
        if (content.trim().length > 100) {
          return { content, source: `file:${sorted[0]}` };
        }
      }
    }
  }

  // Fallback: extract document from worker output
  // Look for YAML frontmatter delimited sections
  const frontmatterMatch = workerOutput.match(/---\n[\s\S]*?\n---\n[\s\S]*/);
  if (frontmatterMatch) {
    return { content: frontmatterMatch[0], source: "worker-output:frontmatter" };
  }

  // Last resort: use the full worker output
  return { content: workerOutput, source: "worker-output:raw" };
}

/**
 * Find .context.md files in a directory (non-recursive).
 */
function findContextFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".context.md"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Worker spawning
// ---------------------------------------------------------------------------

interface SpawnWorkerOptions {
  prompt: string;
  cwd: string;
  engineId: string;
  verbose: boolean;
  stepLabel: string;
}

interface SpawnWorkerResult {
  output: string;
  rawOutput: string;
  exitCode: number;
  durationMs: number;
  failure?: { kind: string; message: string };
}

/**
 * Spawn a worker with the given prompt and capture its output.
 */
async function spawnWorker(options: SpawnWorkerOptions): Promise<SpawnWorkerResult> {
  const { prompt, cwd, engineId, verbose, stepLabel } = options;

  const engine = getEngine(engineId);
  const engineCmd = engine.buildCommand({ prompt });

  // For Claude with stream-json, stdin prompt needs NDJSON wrapping
  let stdinContent = prompt;
  if (engine.metadata.supportsStreamingInput) {
    stdinContent = JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n";
  }

  const spawner = new BunProcessSpawner({ timeoutMinutes: 15 });

  const startTime = Date.now();
  info(`[${stepLabel}] Spawning ${engine.metadata.name} worker...`);

  // Track raw output chunks for text extraction
  const rawChunks: string[] = [];
  const buffer = new TieredBuffer();
  const parser = new NDJSONParser(buffer);

  try {
    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: path.resolve(cwd),
      timeoutMs: 15 * 60_000, // 15 min timeout
      stdin: engineCmd.stdinPrompt ? stdinContent : undefined,
      stdinPipe: engine.metadata.supportsStreamingInput,
      onStdout: (chunk: string) => {
        rawChunks.push(chunk);
        parser.write(chunk);
        if (verbose) {
          process.stdout.write(chunk);
        }
      },
      onStderr: (chunk: string) => {
        if (verbose) {
          process.stderr.write(chunk);
        }
      },
    });

    const result = await spawnResult.result;
    const durationMs = Date.now() - startTime;

    // Flush parser
    parser.flush();
    const tier1 = buffer.getTier1();

    info(`[${stepLabel}] Worker completed in ${(durationMs / 1000).toFixed(1)}s (exit=${result.exitCode})`);

    return {
      output: tier1.content || result.output,
      rawOutput: rawChunks.join(""),
      exitCode: result.exitCode,
      durationMs,
      failure: result.failure ? { kind: result.failure.kind, message: result.failure.message } : undefined,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    return {
      output: buffer.getTier1().content,
      rawOutput: rawChunks.join(""),
      exitCode: -1,
      durationMs,
      failure: { kind: "transient", message },
    };
  }
}

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------

async function runPlanMode(args: CliArgs): Promise<{ output: string; source: string; durationMs: number }> {
  const description = args.description!;
  const absCwd = path.resolve(args.cwd);

  // Build plan step 0 prompt (research step)
  const prompt = buildWorkflowPrompt(0, planWorkflow, { description }, undefined, absCwd);

  info(`Plan research prompt built (${prompt.length} chars)`);
  info(`Target: ${absCwd}`);
  info(`Description: "${description}"`);

  // Snapshot existing .context.md files before spawning
  const preExistingContextFiles = new Set(findContextFiles(absCwd));

  const result = await spawnWorker({
    prompt,
    cwd: args.cwd,
    engineId: args.engine,
    verbose: args.verbose,
    stepLabel: "plan:research",
  });

  if (result.failure) {
    console.error(`\n${RED}Worker failed: ${result.failure.message}${RESET}`);
    if (result.exitCode !== 0 && result.output.length > 0) {
      warn("Attempting to extract output despite failure...");
    } else {
      process.exit(1);
    }
  }

  // Extract the research document (from file or worker output)
  const doc = extractResearchDocument(result.output, "plan", args.cwd, description);

  // Check if new .context.md files were created
  const postContextFiles = findContextFiles(absCwd);
  const newContextFiles = postContextFiles.filter((f) => !preExistingContextFiles.has(f));
  if (newContextFiles.length > 0) {
    info(`Worker created .context.md file(s): ${newContextFiles.join(", ")}`);
    const content = fs.readFileSync(newContextFiles[0], "utf-8");
    if (content.trim().length > 100) {
      return { output: content, source: `file:${newContextFiles[0]}`, durationMs: result.durationMs };
    }
  }

  return { output: doc.content, source: doc.source, durationMs: result.durationMs };
}

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

async function runStandaloneMode(args: CliArgs): Promise<{ output: string; source: string; durationMs: number }> {
  const topic = args.topic!;
  const absCwd = path.resolve(args.cwd);

  let previousResult: string | undefined;
  let totalDurationMs = 0;

  // Run all 3 research steps sequentially
  for (let stepIndex = 0; stepIndex < researchWorkflow.steps.length; stepIndex++) {
    const stepDef = researchWorkflow.steps[stepIndex];
    const stepLabel = `research:step${stepIndex}`;

    info(`\n--- Step ${stepIndex}: ${stepDef.description} ---`);

    const prompt = buildWorkflowPrompt(
      stepIndex,
      researchWorkflow,
      { topic },
      previousResult,
      absCwd,
    );

    info(`Prompt built (${prompt.length} chars)`);

    const result = await spawnWorker({
      prompt,
      cwd: args.cwd,
      engineId: args.engine,
      verbose: args.verbose,
      stepLabel,
    });

    totalDurationMs += result.durationMs;

    if (result.failure) {
      console.error(`\n${RED}Step ${stepIndex} failed: ${result.failure.message}${RESET}`);
      if (result.exitCode !== 0 && result.output.length > 0) {
        warn("Attempting to continue with partial output...");
      } else {
        process.exit(1);
      }
    }

    // Pass output to next step
    previousResult = result.output;
    info(`Step ${stepIndex} output: ${result.output.length} chars`);
  }

  // Extract the final research document
  const doc = extractResearchDocument(previousResult ?? "", "standalone", args.cwd);

  return { output: doc.content, source: doc.source, durationMs: totalDurationMs };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function printValidationResults(result: ValidationResult): void {
  console.log(`\n${BOLD}=== Research Output Validation ===${RESET}\n`);
  console.log(`  File: ${CYAN}${result.file}${RESET}`);
  console.log(`  Variant: ${CYAN}${result.variant}${RESET}`);
  console.log();

  for (const c of result.criteria) {
    const icon = c.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${icon} ${c.criterion}: ${c.details}`);
    if (c.violations && c.violations.length > 0) {
      for (const v of c.violations.slice(0, 5)) {
        console.log(`       ${DIM}Line ${v.line}: ${v.text}${RESET}`);
      }
      if (c.violations.length > 5) {
        console.log(`       ${DIM}... and ${c.violations.length - 5} more${RESET}`);
      }
    }
  }

  console.log();
  if (result.passed) {
    console.log(`  ${GREEN}${BOLD}All criteria passed.${RESET}\n`);
  } else {
    const failed = result.criteria.filter((c) => !c.passed).length;
    console.log(`  ${RED}${BOLD}${failed} criterion/criteria failed.${RESET}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  if (!args) process.exit(0);

  // Print warning banner
  console.log(`\n${YELLOW}${BOLD}⚠️  REAL API CALLS — This script spawns actual AI workers.${RESET}`);
  console.log(`${YELLOW}   Each research phase takes 2-5 minutes and incurs API costs.${RESET}\n`);

  // Check engine availability
  const engineForCheck = getEngine(args.engine);
  const engineAvailable = (() => {
    try { return Bun.which(engineForCheck.metadata.cliBinary) !== null; } catch { return false; }
  })();
  if (!engineAvailable) {
    console.error(`${RED}ERROR${RESET}: Engine '${args.engine}' (${engineForCheck.metadata.cliBinary}) is not available.`);
    console.error(`Install it: ${engineForCheck.metadata.installCommand}`);
    process.exit(1);
  }

  info(`Engine: ${args.engine}`);
  info(`Mode: ${args.mode}`);
  info(`CWD: ${path.resolve(args.cwd)}`);

  // Verify cwd exists
  const absCwd = path.resolve(args.cwd);
  if (!fs.existsSync(absCwd)) {
    console.error(`${RED}ERROR${RESET}: Working directory not found: ${absCwd}`);
    process.exit(1);
  }

  // Run the appropriate mode
  let output: string;
  let source: string;
  let durationMs: number;

  const startTime = Date.now();

  if (args.mode === "plan") {
    ({ output, source, durationMs } = await runPlanMode(args));
  } else {
    ({ output, source, durationMs } = await runStandaloneMode(args));
  }

  // Determine output file path
  const defaultOutputDir = path.join(process.cwd(), "tests", "fixtures", "research");
  fs.mkdirSync(defaultOutputDir, { recursive: true });

  const outputFilename = args.mode === "plan" ? "last-plan-output.md" : "last-standalone-output.md";
  const outputPath = args.outputPath ?? path.join(defaultOutputDir, outputFilename);

  // Write output
  fs.writeFileSync(outputPath, output, "utf-8");
  console.log(`\n${BOLD}=== Output ===${RESET}`);
  info(`Source: ${source}`);
  info(`Length: ${output.length} chars`);
  info(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  info(`Saved to: ${outputPath}`);

  // Validate
  if (!args.skipValidation) {
    const variant: ResearchVariant = args.mode === "plan" ? "plan" : "standalone";
    const validationResult = validateResearchOutput(output, variant, outputPath);

    printValidationResults(validationResult);

    // Print JSON for programmatic consumption
    const jsonPath = outputPath.replace(/\.md$/, ".validation.json");
    fs.writeFileSync(jsonPath, JSON.stringify(validationResult, null, 2), "utf-8");
    info(`Validation JSON saved to: ${jsonPath}`);

    if (!validationResult.passed) {
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n${RED}${BOLD}FAILED${RESET} — Total time: ${totalTime}s\n`);
      process.exit(1);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${GREEN}${BOLD}PASSED${RESET} — Total time: ${totalTime}s\n`);
  } else {
    info("Validation skipped (--skip-validation)");
  }
}

main().catch((error) => {
  console.error(`${RED}Unhandled error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
  if (error instanceof Error && error.stack) {
    console.error(`${DIM}${error.stack}${RESET}`);
  }
  process.exit(1);
});
