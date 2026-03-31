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
  "You are a verification agent with a strict 60-second time limit. " +
  "Your ONLY job is to evaluate the worker's output against acceptance criteria and write a JSON verdict. " +
  "You have tools (Read, Bash, Grep, Glob, Write) but use them SPARINGLY — at most 2-3 quick checks. " +
  "Do NOT explore the codebase broadly. Do NOT read files unless directly needed to verify a specific claim. " +
  "Evaluate from the provided input first. Only use tools to spot-check suspicious claims. " +
  "WRITE THE HANDOFF JSON FILE IMMEDIATELY after forming your verdict — do not delay.";

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
      sections.push("## Task Context", input.task_context, "");
    }

    // Worker handoff data
    if (input.handoff) {
      sections.push("## Worker Summary", input.handoff.summary, "");

      if (input.handoff.verification) {
        sections.push(
          "## Worker-Reported Verification",
          `Tests passed: ${input.handoff.verification.tests_passed === null ? "unknown" : input.handoff.verification.tests_passed ? "yes" : "no"}`,
        );
        if (input.handoff.verification.test_output_summary) {
          sections.push(input.handoff.verification.test_output_summary);
        }
        sections.push("");
      }

      if (input.handoff.artifacts) {
        const filesCreated = input.handoff.artifacts.files_created ?? [];
        const filesModified = input.handoff.artifacts.files_modified ?? [];
        const commandsRun = input.handoff.artifacts.commands_run ?? [];
        if (filesCreated.length > 0 || filesModified.length > 0 || commandsRun.length > 0) {
          sections.push("## Worker-Reported Artifacts");
          if (filesCreated.length > 0) {
            sections.push("Files created:", ...filesCreated.map((f) => `- \`${f}\``));
          }
          if (filesModified.length > 0) {
            sections.push("Files modified:", ...filesModified.map((f) => `- \`${f}\``));
          }
          if (commandsRun.length > 0) {
            sections.push("Commands run:", ...commandsRun.map((c) => {
              if (typeof c === "string") return `- \`${c}\` (claimed exit code: 0)`;
              const obj = c as Record<string, unknown>;
              return `- \`${obj.command}\` (claimed exit code: ${obj.exitCode ?? obj.exit_code ?? 0})`;
            }));
          }
          sections.push("");
        }
      }

      if (input.handoff.files_to_review && input.handoff.files_to_review.length > 0) {
        sections.push(
          "## Files to Review",
          ...input.handoff.files_to_review.map((f) => `- \`${f}\``),
          "",
        );
      }
    } else {
      sections.push("## Worker Output", input.worker_output, "");
    }

    sections.push("## Evaluation Criteria", input.evaluation_criteria, "");

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
      sections.push("## Test Results", `Tests passed: ${input.tests_passed ? "yes" : "no"}`, "");
    }

    if (input.context_files.length > 0) {
      sections.push(
        "## Files the Worker Had Access To",
        ...input.context_files.map((f) => `- \`${f}\``),
        "",
      );
    }

    sections.push("## Timing", `Step took ${input.duration_seconds}s to complete.`, "");

    // -----------------------------------------------------------------------
    // Verification instructions — the evaluator has tools to investigate
    // -----------------------------------------------------------------------
    sections.push(
      "## Verification Procedure",
      "",
      "You have tools: Read, Bash, Grep, Glob, Write. Use them to verify the worker's claims.",
      "",
      "### Step 1: Verify Files Exist",
      "For each file the worker claims to have created or modified, check that it exists on disk.",
      "If a claimed file is missing, use Grep/Glob to search for it — the worker may have written",
      "it to a slightly different path. If you find it elsewhere, note the discrepancy but do NOT",
      "fail the step for a path mismatch alone.",
      "",
      "### Step 2: Re-run Claimed Commands",
      "For each command the worker claims to have run (listed under Worker-Reported Artifacts),",
      "re-run it using Bash and compare the exit code to what the worker claimed. If a command",
      "fails when the worker said it passed, investigate why — read the output, check if the",
      "failure is due to environment differences, or if the worker genuinely fabricated results.",
      "A grep returning no matches (exit code 1) when the worker claimed exit code 0 may mean",
      "the code was already cleaned up correctly — investigate before failing.",
      "",
      "### Step 3: Check Acceptance Criteria",
      "Compare the worker's output against each acceptance criterion. Use your tools to spot-check",
      "claims — e.g., if a criterion says 'tests pass', run the test command. If it says 'file",
      "contains X', read the file and verify.",
      "",
      "### Step 4: Security Scan",
      "Scan the worker's output and any created/modified files for secrets, credentials, or API keys",
      "(patterns: AKIA..., sk-..., ghp_..., passwords, connection strings).",
      "",
    );

    // -----------------------------------------------------------------------
    // Verdict instructions
    // -----------------------------------------------------------------------
    sections.push(
      "## Verdict Instructions",
      "",
      "After investigating, write your JSON verdict to the handoff file. Schema:",
      '`{ "passed": boolean, "reasoning": string, "suggestions": string[], "confidence": number, "feedback": string, "files_to_review": string[], "issues": Issue[] }`',
      "",
      "Field definitions:",
      "- **passed**: true if the output substantially meets acceptance criteria. Bias toward passing.",
      "- **reasoning**: your assessment based on what you investigated and found.",
      "- **suggestions**: improvement suggestions (empty array [] if none).",
      "- **confidence**: float 0.0-1.0. 0.9+ = clear verdict, 0.5-0.7 = borderline.",
      "- **feedback**: actionable feedback for the worker if retrying. Empty string if passed.",
      "- **files_to_review**: file paths needing further review (empty array [] if none).",
      "- **issues**: structured issues found. Each: `{description, severity, category}`",
      '  - severity: "blocking" or "non_blocking"',
      '  - category: "test_failure" | "type_error" | "security" | "regression" | "incomplete" | "other"',
      "",
      "## CRITICAL: Bias Toward Passing",
      "",
      "Revision loops are EXPENSIVE — they double the cost and time of a step.",
      "Only fail when you have HARD EVIDENCE from your investigation:",
      "- You re-ran tests and they actually fail",
      "- You found secrets/credentials in files you read",
      "- Critical deliverables are genuinely missing (not just at a different path)",
      "- The worker's output is fundamentally wrong or addresses the wrong task",
      "",
      "Do NOT fail for: path discrepancies (if the file exists elsewhere), format deviations,",
      "the worker taking a different but valid approach, or minor differences from criteria wording.",
      "When in doubt, pass with suggestions.",
    );

    return sections.join("\n");
  }
}
