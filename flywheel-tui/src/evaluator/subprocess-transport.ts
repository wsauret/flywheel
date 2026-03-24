/**
 * SubprocessEvaluatorTransport — engine-aware evaluator invocation via subprocess.
 *
 * Uses the engine registry to build commands with per-engine optimization flags.
 * - Claude Code: --print, --tools "", --system-prompt, --no-session-persistence, --effort low, -p
 * - OpenCode: run --format json, --model, stdin prompt delivery
 *
 * Same transport pattern as src/dispatcher/subprocess-transport.ts.
 * Uses ProcessSpawner (DI seam, same pattern as worker).
 * Applies createEnvFilter() for env sanitization.
 * 30s timeout. On parse failure: retry ONCE with error feedback.
 */

import type { EvaluatorInput, EvaluatorResult } from "../schemas/evaluator";
import type { EvaluatorTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine } from "../engines/core/types";
import { EvaluatorResultSchema } from "../schemas/evaluator";
import { createEnvFilter } from "../worker/env-filter";
import { getEngine } from "../engines/core/registry";
import { extractTextFromNDJSON } from "../utils/ndjson-text-extractor";
import { Log } from "../utils/log";

const log = Log.create({ service: "evaluator-subprocess" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/** Evaluator system prompt — used as --system-prompt for Claude (separate for caching). */
const EVALUATOR_SYSTEM_PROMPT =
  "You are an evaluator checking whether worker output meets the validation criteria. " +
  "Evaluate the output against all provided criteria and respond with valid JSON only.";

// ---------------------------------------------------------------------------
// SubprocessEvaluatorTransport
// ---------------------------------------------------------------------------

export interface SubprocessEvaluatorTransportOptions {
  spawner: ProcessSpawner;
  /** Engine name — "claude" or "opencode". Defaults to "opencode" for backward compatibility. */
  engineName?: string;
  /** Evaluator model override — flows to --model CLI flag. Uses engine default when not set. */
  evaluatorModel?: string;
}

export class SubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();
  private readonly engine: Engine;
  private readonly evaluatorModel: string | undefined;

  constructor(options: SubprocessEvaluatorTransportOptions) {
    this.spawner = options.spawner;
    this.evaluatorModel = options.evaluatorModel;

    // Resolve engine from registry — defaults to "opencode" for backward compat
    const engineName = options.engineName ?? "opencode";
    this.engine = getEngine(engineName);

    // Check binary availability upfront
    const binary = this.engine.metadata.cliBinary;
    if (!Bun.which(binary)) {
      throw new Error(
        `${binary} CLI not found — install it with: ${this.engine.metadata.installCommand} ` +
        `(or change the engine config to use a different engine)`,
      );
    }
  }

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    const userMessage = this.buildPrompt(input);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please output valid JSON matching the schema.`
        : "";

      // Build the engine-specific command via the registry
      const engineCmd = this.engine.buildDispatcherCommand({
        prompt: userMessage + retryNote,
        systemPrompt: EVALUATOR_SYSTEM_PROMPT,
        model: this.evaluatorModel,
      });

      log.info("spawning evaluator", {
        engine: this.engine.metadata.id,
        command: engineCmd.command,
        attempt: attempt + 1,
        model: this.evaluatorModel ?? "(default)",
      });

      const env = this.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      // Determine stdin content — Claude uses -p flag (no stdin), OpenCode uses stdin
      const stdinContent = engineCmd.stdinPrompt
        ? `${EVALUATOR_SYSTEM_PROMPT}\n\n---\n\n${userMessage}${retryNote}`
        : undefined;

      const { result: resultPromise } = await this.spawner.spawn(
        engineCmd.command,
        engineCmd.args,
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: stdinContent,
          env,
        },
      );
      const result = await resultPromise;

      // Parse output using engine-appropriate strategy
      const parseResult = this.parseOutput(result.output);
      if (parseResult.success) {
        return parseResult.data;
      }

      lastError = new Error(parseResult.error);
    }

    throw new Error(
      `Evaluator subprocess failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildPrompt(input: EvaluatorInput): string {
    // NOTE: Role framing is set in EVALUATOR_SYSTEM_PROMPT (passed via --system-prompt).
    // Do NOT duplicate it here — the system prompt already establishes the evaluator role.
    const sections: string[] = [];

    // Task context section (when present) — placed before worker output
    // so the evaluator understands what the worker was trying to accomplish.
    if (input.task_context) {
      sections.push(
        "## Task Context",
        input.task_context,
        "",
      );
    }

    sections.push(
      "## Worker Output",
      input.worker_output,
      "",
      "## Validation Criteria",
      input.validation_criteria,
      "",
    );

    if (input.acceptance_criteria.length > 0) {
      sections.push(
        "## Acceptance Criteria",
        ...input.acceptance_criteria.map((c) => `- ${c}`),
        "",
      );
    }

    if (input.artifacts_produced.length > 0) {
      sections.push(
        "## Artifacts Produced",
        ...input.artifacts_produced.map((a) => `- ${a}`),
        "",
      );
    }

    if (input.tests_passed !== null) {
      sections.push(
        "## Test Results",
        `Tests passed: ${input.tests_passed ? "yes" : "no"}`,
        "",
      );
    }

    // Informational only — tools are disabled so the model cannot read these files.
    if (input.context_files.length > 0) {
      sections.push(
        "The worker was given access to these files:",
        ...input.context_files.map((f) => `- ${f}`),
        "",
      );
    }

    // Surface timing so the evaluator knows if work was rushed or thorough.
    sections.push(
      "## Timing",
      `Phase took ${input.duration_seconds}s to complete.`,
      "",
    );

    sections.push(
      "## Instructions",
      "Evaluate the worker output against the validation criteria. Respond with valid JSON only, matching this exact schema:",
      '{ "passed": boolean, "reasoning": string, "suggestions": string[], "confidence": number, "feedback": string, "files_to_review": string[] }',
      "",
      "- passed: Set passed to true if the output substantially meets the acceptance criteria. Minor omissions that don't affect functionality should not cause a failure. Set passed to false only if critical criteria are unmet or the output has significant issues.",
      "- reasoning: string explaining your assessment of the output",
      "- suggestions: array of improvement suggestions (empty array [] if none)",
      "- confidence: float between 0.0 and 1.0 (NOT 0-100, must be a decimal like 0.85). confidence should reflect how certain you are about your pass/fail decision: 0.9+ means clear pass/fail, 0.5-0.7 means borderline, below 0.5 means you lack enough information to judge.",
      "- feedback: string with overall feedback about the work quality",
      "- files_to_review: array of file paths that need further review (empty array [] if none)",
    );

    return sections.join("\n");
  }

  private parseOutput(
    output: string,
  ):
    | { success: true; data: EvaluatorResult }
    | { success: false; error: string } {
    // Engine-specific output parsing:
    // - OpenCode outputs NDJSON (newline-delimited JSON events)
    // - Claude Code --print outputs plain text (raw response)
    const isOpenCode = this.engine.metadata.id === "opencode";

    let source: string;
    if (isOpenCode) {
      const textContent = extractTextFromNDJSON(output);
      source = textContent || output;
    } else {
      // Claude Code --print: output is plain text, may contain JSON directly
      source = output;
    }

    const jsonMatch = source.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        error: `No JSON found in output: ${source.slice(0, 200)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return {
        success: false,
        error: `Invalid JSON: ${jsonMatch[0].slice(0, 200)}`,
      };
    }

    const result = EvaluatorResultSchema.safeParse(parsed);
    if (!result.success) {
      return {
        success: false,
        error: `Schema validation failed: ${result.error.message}`,
      };
    }

    return { success: true, data: result.data };
  }
}
