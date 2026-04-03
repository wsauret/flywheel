/**
 * Standalone CLI entry point for the agent harness.
 *
 * Exercises the agent loop directly — no TUI, no queue orchestrator.
 * Fast feedback loop for development and testing.
 *
 * Usage:
 *   bin/harness "read package.json and tell me the project name"
 *   bin/harness "find all TypeScript files that import from zod" --verbose
 *   bin/harness --help
 */

import { runAgentLoop } from "./agent-loop.js";
import type { AgentLoopStatus } from "./agent-loop.js";
import { AnthropicProvider } from "./anthropic.js";
import { gatherWorkspaceContext, buildSystemPrompt } from "./prompts.js";
import { createConsoleTracer, estimateCost } from "./tracer.js";
import { createBashTool } from "./tools/bash.js";
import { createReadTool } from "./tools/read.js";
import { editTool } from "./tools/edit.js";
import { textSearchTool } from "./tools/text-search.js";
import { astSearchTool } from "./tools/ast-search.js";
import { taskCompleteTool } from "./tools/task-complete.js";
import type { HarnessTool } from "./tools/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_TOKENS = 16384;

const USAGE_TEXT = `
Usage: bin/harness <task> [options]

Run an autonomous coding agent from the command line.

Arguments:
  <task>                  The task message to send to the agent (required)

Options:
  --model <model>         LLM model to use (default: ${DEFAULT_MODEL})
  --max-turns <n>         Maximum conversation turns (default: ${DEFAULT_MAX_TURNS})
  --max-tokens <n>        Maximum output tokens per turn (default: ${DEFAULT_MAX_TOKENS})
  --verbose, -v           Enable verbose tracing output
  --thinking <budget>     Enable extended thinking with budget_tokens
  --help, -h              Show this help message

Examples:
  bin/harness "read package.json and tell me the project name"
  bin/harness "find all TypeScript files that import from zod" --verbose
  bin/harness "add a comment at the top of src/harness/llm.ts" --model claude-sonnet-4-6
  bin/harness --help
`.trim();

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  task: string;
  model: string;
  maxTurns: number;
  maxTokens: number;
  verbose: boolean;
  thinking: number | null;
  help: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
  let task = "";
  let model = DEFAULT_MODEL;
  let maxTurns = DEFAULT_MAX_TURNS;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let verbose = false;
  let thinking: number | null = null;
  let help = false;

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--model") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--model requires a value");
      }
      model = next;
      i++;
    } else if (arg === "--max-turns") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--max-turns requires a value");
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--max-turns must be a positive integer, got: ${next}`);
      }
      maxTurns = Math.floor(n);
      i++;
    } else if (arg === "--max-tokens") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--max-tokens requires a value");
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--max-tokens must be a positive integer, got: ${next}`);
      }
      maxTokens = Math.floor(n);
      i++;
    } else if (arg === "--thinking") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--thinking requires a budget_tokens value");
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--thinking must be a positive integer, got: ${next}`);
      }
      thinking = Math.floor(n);
      i++;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  task = positional.join(" ");

  return { task, model, maxTurns, maxTokens, verbose, thinking, help };
}

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

function exitCodeForStatus(status: AgentLoopStatus): number {
  switch (status) {
    case "completed":
      return 0;
    case "error":
    case "doom_loop":
    case "max_turns":
    case "aborted":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCli(args: string[]): Promise<void> {
  // 1. Parse arguments
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    console.error(`Run 'bin/harness --help' for usage.`);
    process.exit(1);
  }

  // 2. Handle --help
  if (parsed.help) {
    console.log(USAGE_TEXT);
    return;
  }

  // 3. Validate task message
  if (!parsed.task.trim()) {
    console.error("Error: No task message provided.");
    console.error(`Run 'bin/harness --help' for usage.`);
    process.exit(1);
  }

  // 4. Validate API key
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("Set it with: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  // 5. Gather workspace context and build system prompt
  const context = await gatherWorkspaceContext();
  const systemPrompt = buildSystemPrompt(context);

  // 6. Create all tools
  const tools: HarnessTool[] = [
    createBashTool(),
    createReadTool(),
    editTool,
    textSearchTool,
    astSearchTool,
    taskCompleteTool,
  ];

  // 7. Create provider
  const provider = new AnthropicProvider({ apiKey });

  // 8. Create console tracer
  const tracer = createConsoleTracer({ verbose: parsed.verbose, model: parsed.model });

  // 9. Wire SIGINT to AbortController
  const controller = new AbortController();
  let sigintCount = 0;

  const onSigint = () => {
    sigintCount++;
    if (sigintCount === 1) {
      console.log("\nAborting... (press Ctrl+C again to force exit)");
      controller.abort();
    } else {
      process.exit(130);
    }
  };

  process.on("SIGINT", onSigint);

  // 10. Run agent loop
  const startTime = Date.now();

  try {
    const result = await runAgentLoop({
      provider,
      tools,
      systemPrompt,
      initialMessage: parsed.task,
      model: parsed.model,
      maxTokens: parsed.maxTokens,
      maxTurns: parsed.maxTurns,
      ...(parsed.thinking !== null
        ? { thinking: { type: "enabled" as const, budgetTokens: parsed.thinking } }
        : {}),
      abortSignal: controller.signal,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      onTrace: tracer,
      onTextDelta: (text: string) => {
        process.stdout.write(text);
      },
    });

    const durationSec = (Date.now() - startTime) / 1000;

    // Print handoff summary if available
    if (result.handoff) {
      const handoff = result.handoff as Record<string, unknown>;
      if (typeof handoff["summary"] === "string") {
        console.log(`\nSummary: ${handoff["summary"]}`);
      }
    }

    // Print final usage stats
    const totalTokens = result.totalUsage.inputTokens + result.totalUsage.outputTokens;
    const cost = estimateCost(result.totalUsage, parsed.model);
    console.log(
      `\n${result.status} | ${result.totalTurns} turns | ${durationSec.toFixed(1)}s | ${totalTokens.toLocaleString()} tokens | $${cost.toFixed(4)}`,
    );

    process.exit(exitCodeForStatus(result.status));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nFatal error: ${message}`);
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

// ---------------------------------------------------------------------------
// Auto-run when executed directly
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  runCli(args).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
