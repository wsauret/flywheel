/**
 * SubprocessEvaluatorTransport — agent-based evaluator invocation via subprocess.
 *
 * Uses the engine registry to build evaluator commands with tool access
 * (Read, Bash, Write, Grep, Glob) so the evaluator can investigate:
 * - Re-run commands the worker claims to have run
 * - Check that reported files exist on disk
 * - Grep for files that may have been written to different paths
 * - Verify acceptance criteria are met
 *
 * Same transport pattern as src/dispatcher/subprocess-transport.ts.
 * Uses ProcessSpawner (DI seam, same pattern as worker).
 * Applies createEnvFilter() for env sanitization.
 * 60s timeout. On parse failure: retry ONCE with error feedback.
 *
 * Verdict is read from a handoff file (not stdout parsing).
 * The evaluator agent writes a JSON verdict to a file path included in the prompt.
 */

import * as nodePath from "node:path";
import * as fs from "node:fs";
import type { EvaluatorInput, EvaluatorResult } from "./schemas";
import type { EvaluatorTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine } from "../engines/core/types";
import { createEnvFilter } from "../worker/env-filter";
import { getEngine } from "../engines/core/registry";
import { renderEvaluatorHandoffInstruction } from "../queue/shared/handoff-render";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../queue/shared/handoff-reader";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "./schemas";
import { Log } from "../utils/log";
import { SubprocessLogger, createLoggedCallbacks } from "../utils/subprocess-logger.js";
import { buildEvaluatorHandoffPath, ensureSessionDir } from "../config/paths";

const log = Log.create({ service: "evaluator-subprocess" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

/** Evaluator system prompt — used as --system-prompt for Claude (separate for caching). */
const EVALUATOR_SYSTEM_PROMPT =
  "You are a 60-second verification agent. Read the input, form a verdict, write the JSON file. " +
  "You have tools but should almost never need them. Only use a tool if you see a specific red flag " +
  "that requires one quick check to confirm. Write the verdict file IMMEDIATELY — every second counts.";

// ---------------------------------------------------------------------------
// SubprocessEvaluatorTransport
// ---------------------------------------------------------------------------

export interface SubprocessEvaluatorTransportOptions {
  spawner: ProcessSpawner;
  /** Engine name — "claude" or "opencode". Defaults to "opencode" for backward compatibility. */
  engineName?: string;
  /** Evaluator model override — flows to --model CLI flag. Uses engine default when not set. */
  evaluatorModel?: string;
  /** Called with each decoded stdout chunk as it arrives from the evaluator subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the evaluator subprocess. */
  onStderr?: (chunk: string) => void;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId?: string;
  /** Project base directory for path resolution. */
  baseDir?: string;
  /** Optional addendum appended to the evaluator system prompt (e.g. sprint adversarial instructions). */
  systemPromptAddendum?: string;
}

export class SubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();
  private readonly engine: Engine;
  private readonly evaluatorModel: string | undefined;
  private readonly onStdout?: (chunk: string) => void;
  private readonly onStderr?: (chunk: string) => void;
  private readonly logBaseDir?: string;
  private readonly sessionId?: string;
  private readonly baseDir: string;
  private readonly systemPrompt: string;

  constructor(options: SubprocessEvaluatorTransportOptions) {
    this.spawner = options.spawner;
    this.evaluatorModel = options.evaluatorModel;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
    this.logBaseDir = options.logBaseDir;
    this.sessionId = options.sessionId;
    this.baseDir = options.baseDir ?? process.cwd();
    this.systemPrompt = options.systemPromptAddendum
      ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${options.systemPromptAddendum}`
      : EVALUATOR_SYSTEM_PROMPT;

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
    const invocationId = crypto.randomUUID();
    if (!this.sessionId) {
      throw new Error("SubprocessEvaluatorTransport requires sessionId for handoff path construction");
    }
    ensureSessionDir(this.sessionId, this.baseDir);
    const handoffPath = buildEvaluatorHandoffPath(this.sessionId, invocationId, this.baseDir);

    const userMessage = this.buildPrompt(input);
    // Append handoff instruction so the evaluator writes its verdict to a file
    const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
    const fullPrompt = `${userMessage}\n\n${handoffInstruction}`;

    // Create subprocess logger if logBaseDir is configured (OUTSIDE retry loop)
    const spLogger = this.logBaseDir
      ? new SubprocessLogger({ baseDir: this.logBaseDir, role: "evaluator", invocationId, sessionId: this.sessionId })
      : null;
    const { onStdout: effectiveOnStdout, onStderr: effectiveOnStderr } = spLogger
      ? createLoggedCallbacks(spLogger, { onStdout: this.onStdout, onStderr: this.onStderr })
      : { onStdout: this.onStdout, onStderr: this.onStderr };

    let lastError: Error | null = null;

    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const retryNote = attempt > 0
          ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
          : "";

        // Build the engine-specific evaluator command (with tool access)
        const engineCmd = this.engine.buildEvaluatorCommand({
          prompt: fullPrompt + retryNote,
          systemPrompt: this.systemPrompt,
          model: this.evaluatorModel,
        });

        log.info("spawning evaluator", {
          engine: this.engine.metadata.id,
          command: engineCmd.command,
          attempt: attempt + 1,
          model: this.evaluatorModel ?? "(default)",
          handoffPath,
        });

        const env = this.envFilter.filter(
          process.env as Record<string, string | undefined>,
        );

        // Determine stdin content — Claude uses -p flag (no stdin), OpenCode uses stdin
        const stdinContent = engineCmd.stdinPrompt
          ? `${this.systemPrompt}\n\n---\n\n${fullPrompt}${retryNote}`
          : undefined;

        const { result: resultPromise } = await this.spawner.spawn(
          engineCmd.command,
          engineCmd.args,
          {
            timeoutMs: CLI_TIMEOUT_MS,
            stdin: stdinContent,
            env,
            onStdout: effectiveOnStdout,
            onStderr: effectiveOnStderr,
          },
        );
        await resultPromise;

        // Read verdict from handoff file (not stdout)
        try {
          const verdict = await readHandoff(handoffPath, EvaluatorVerdictSchema) as EvaluatorVerdict;
          // Map EvaluatorVerdict to EvaluatorResult (same fields; suggestions is required in verdict, optional in result)
          return {
            passed: verdict.passed,
            reasoning: verdict.reasoning,
            suggestions: verdict.suggestions,
            confidence: verdict.confidence,
            feedback: verdict.feedback,
            files_to_review: verdict.files_to_review,
            issues: verdict.issues,
          };
        } catch (err) {
          if (err instanceof HandoffMissingError || err instanceof HandoffInvalidError) {
            lastError = err;
            log.warn("evaluator handoff read failed, retrying", {
              attempt: attempt + 1,
              error: err.message,
            });
            continue;
          }
          // Unexpected error — propagate
          throw err;
        }
      }

      throw new Error(
        `Evaluator subprocess failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
      );
    } finally {
      spLogger?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildPrompt(input: EvaluatorInput): string {
    const sections: string[] = [];

    // Task context
    if (input.task_context) {
      sections.push(`## Task\n${input.task_context}`, "");
    }

    // Worker handoff data (compact)
    if (input.handoff) {
      sections.push(`## Worker Summary\n${input.handoff.summary}`, "");

      if (input.handoff.verification) {
        const testStatus = input.handoff.verification.tests_passed === null ? "unknown"
          : input.handoff.verification.tests_passed ? "yes" : "no";
        sections.push(`Tests passed: ${testStatus}`);
        if (input.handoff.verification.test_output_summary) {
          sections.push(input.handoff.verification.test_output_summary);
        }
        sections.push("");
      }

      if (input.handoff.artifacts) {
        const created = input.handoff.artifacts.files_created ?? [];
        const modified = input.handoff.artifacts.files_modified ?? [];
        const all = [...created.map(f => `+ ${f}`), ...modified.map(f => `~ ${f}`)];
        if (all.length > 0) {
          sections.push(`## Artifacts\n${all.join("\n")}`, "");
        }
      }
    } else {
      sections.push(`## Worker Output\n${input.worker_output}`, "");
    }

    if (input.evaluation_criteria) {
      sections.push(`## Criteria\n${input.evaluation_criteria}`, "");
    }

    if (input.acceptance_criteria.length > 0) {
      sections.push(`## Acceptance\n${input.acceptance_criteria.map(c => `- ${c}`).join("\n")}`, "");
    }

    // Verdict instructions — kept minimal for speed
    sections.push(
      `## Verdict`,
      "",
      "You have 60 seconds. Read the above, decide pass/fail, write the JSON verdict file.",
      "Only use tools if you see a specific red flag that needs one quick check to confirm.",
      "",
      "Fail ONLY for hard evidence: tests actually failing, secrets in code, critical deliverables missing, or fundamentally wrong output.",
      "When in doubt, pass with suggestions. Revision loops are expensive.",
      "",
      "Write this JSON to the handoff file:",
      "```json",
      `{ "passed": true, "reasoning": "...", "suggestions": [], "confidence": 0.9, "feedback": "", "files_to_review": [], "issues": [] }`,
      "```",
      "",
      "issues schema: `{description: string, severity: \"blocking\"|\"non_blocking\", category: \"test_failure\"|\"type_error\"|\"security\"|\"regression\"|\"incomplete\"|\"other\"}`",
    );

    return sections.join("\n");
  }
}
