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
 *
 * Verdict is read from a handoff file (not stdout parsing).
 * The evaluator LLM writes a JSON verdict to a file path included in the prompt.
 */

import * as nodePath from "node:path";
import * as fs from "node:fs";
import type { EvaluatorInput, EvaluatorResult } from "../schemas/evaluator";
import type { EvaluatorTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine } from "../engines/core/types";
import { createEnvFilter } from "../worker/env-filter";
import { getEngine } from "../engines/core/registry";
import { renderEvaluatorHandoffInstruction } from "../handoff/field-specs";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../handoff/reader";
import { EvaluatorVerdictSchema } from "../schemas/handoff";
import type { EvaluatorVerdict } from "../schemas/handoff";
import { Log } from "../utils/log";
import { SubprocessLogger, createLoggedCallbacks } from "../utils/subprocess-logger.js";
import { HANDOFFS_DIR } from "../config/paths";

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
  /** Called with each decoded stdout chunk as it arrives from the evaluator subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the evaluator subprocess. */
  onStderr?: (chunk: string) => void;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
}

export class SubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();
  private readonly engine: Engine;
  private readonly evaluatorModel: string | undefined;
  private readonly onStdout?: (chunk: string) => void;
  private readonly onStderr?: (chunk: string) => void;
  private readonly logBaseDir?: string;

  constructor(options: SubprocessEvaluatorTransportOptions) {
    this.spawner = options.spawner;
    this.evaluatorModel = options.evaluatorModel;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
    this.logBaseDir = options.logBaseDir;

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
    const handoffsDir = nodePath.resolve(
      process.cwd(),
      HANDOFFS_DIR,
    );
    fs.mkdirSync(handoffsDir, { recursive: true });
    const handoffPath = nodePath.resolve(handoffsDir, `${invocationId}.json`);

    const userMessage = this.buildPrompt(input);
    // Append handoff instruction so the evaluator writes its verdict to a file
    const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
    const fullPrompt = `${userMessage}\n\n${handoffInstruction}`;

    // Create subprocess logger if logBaseDir is configured (OUTSIDE retry loop)
    const spLogger = this.logBaseDir
      ? new SubprocessLogger({ baseDir: this.logBaseDir, role: "evaluator", invocationId })
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

        // Build the engine-specific command via the registry
        const engineCmd = this.engine.buildDispatcherCommand({
          prompt: fullPrompt + retryNote,
          systemPrompt: EVALUATOR_SYSTEM_PROMPT,
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
          ? `${EVALUATOR_SYSTEM_PROMPT}\n\n---\n\n${fullPrompt}${retryNote}`
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

    // When structured handoff data is available, render it instead of raw worker_output
    if (input.handoff) {
      sections.push(
        "## Worker Summary",
        input.handoff.summary,
        "",
      );

      if (input.handoff.verification) {
        sections.push(
          "## Verification",
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
          sections.push("## Artifacts");
          if (filesCreated.length > 0) {
            sections.push("Files created:", ...filesCreated.map((f) => `- ${f}`));
          }
          if (filesModified.length > 0) {
            sections.push("Files modified:", ...filesModified.map((f) => `- ${f}`));
          }
          if (commandsRun.length > 0) {
            sections.push("Commands run:", ...commandsRun.map((c) => `- ${c}`));
          }
          sections.push("");
        }
      }

      if (input.handoff.files_to_review && input.handoff.files_to_review.length > 0) {
        sections.push(
          "## Files to Review",
          ...input.handoff.files_to_review.map((f) => `- ${f}`),
          "",
        );
      }
    } else {
      // Backward compat: render raw worker_output when no handoff data
      sections.push(
        "## Worker Output",
        input.worker_output,
        "",
      );
    }

    sections.push(
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
      '{ "passed": boolean, "reasoning": string, "suggestions": string[], "confidence": number, "feedback": string, "files_to_review": string[], "issues": Issue[] }',
      "",
      "- passed: Set passed to true if the output substantially meets the acceptance criteria. Be generous — minor omissions, format variations, and stylistic differences should NOT cause a failure. The worker produced useful output that advances the workflow? Pass it. Set passed to false ONLY if critical criteria are completely unmet, the output is fundamentally wrong, or there are blocking issues (test failures, security problems, regressions). When in doubt, pass with suggestions rather than fail.",
      "- reasoning: string explaining your assessment of the output",
      "- suggestions: array of improvement suggestions (empty array [] if none)",
      "- confidence: float between 0.0 and 1.0 (NOT 0-100, must be a decimal like 0.85). confidence should reflect how certain you are about your pass/fail decision: 0.9+ means clear pass/fail, 0.5-0.7 means borderline, below 0.5 means you lack enough information to judge.",
      "- feedback: string with overall feedback about the work quality",
      "- files_to_review: array of file paths that need further review (empty array [] if none)",
      "- issues: array of structured issues found in the worker output. Each issue is an object with:",
      '  - description: string describing the issue (must not be empty)',
      '  - severity: "blocking" or "non_blocking"',
      '  - category: one of "test_failure", "type_error", "security", "regression", "incomplete", "other"',
      "",
      "## CRITICAL: Bias Toward Passing",
      "",
      "Revision loops are EXPENSIVE — they double the cost and time of a phase. You should strongly bias toward passing with suggestions rather than failing. Only fail when:",
      "- Tests are failing or typecheck has errors (hard evidence of breakage)",
      "- Security issues found (credentials, secrets in code)",
      "- The output is fundamentally wrong or addresses the wrong task entirely",
      "- Critical deliverables are completely missing (not just in a different format)",
      "",
      "Do NOT fail for: format deviations, missing optional sections, slight wording differences from acceptance criteria, the worker taking a different but valid approach, or the output being organized differently than expected.",
      "",
      "## CRITICAL: You Cannot Verify File Existence",
      "",
      "You have NO tools — you cannot read files, run commands, or check if files exist on disk. If the worker says they created a file, TRUST THEIR CLAIM. Do NOT fail because you 'cannot verify the file exists'. If the worker's summary describes creating the required deliverables and the content sounds correct, that is sufficient to pass. Only fail if the worker's own output contradicts their claims or indicates they didn't do the work.",
      "",
      "## Issue Extraction Guidelines",
      "",
      "Extract and classify ALL issues you find in the worker output into the `issues` array. If no issues are found, use an empty array `[]`.",
      "",
      "### Severity Classification",
      '- **blocking**: Issues that MUST be fixed before proceeding. These halt the pipeline.',
      '- **non_blocking**: Issues that should be addressed but don\'t prevent progress.',
      "",
      "### Category Classification",
      '- **test_failure**: Unit tests, integration tests, or E2E tests are failing. BLOCKING if the worker claimed tests passed but evidence shows otherwise, or if required tests are missing.',
      '- **type_error**: TypeScript compilation errors, type mismatches, or missing type definitions. BLOCKING if typecheck was required and fails.',
      '- **security**: API keys, passwords, credentials, or secrets found in source code, logs, or output. Always BLOCKING.',
      '- **regression**: Previously working functionality is now broken. BLOCKING.',
      '- **incomplete**: Acceptance criteria partially met, missing edge cases, or incomplete implementation. May be blocking or non-blocking depending on severity.',
      '- **other**: Issues that don\'t fit other categories (style, performance, documentation).',
      "",
      "### Checks to Perform",
      "1. **Test/typecheck results**: If the worker handoff indicates tests failed or typecheck has errors, classify as blocking test_failure or type_error.",
      "2. **Secrets/credentials**: Look for patterns like API keys (AKIA..., sk-..., ghp_...), passwords, tokens, or connection strings in the worker output. Classify as blocking security.",
      "3. **Regression indicators**: If the worker mentions breaking existing functionality or existing tests now failing, classify as blocking regression.",
      "4. **Completeness**: Compare worker output against acceptance criteria. Missing critical criteria are blocking incomplete; minor gaps are non_blocking incomplete.",
      "",
      "### Examples",
      '```json',
      '// Worker reported failing tests → blocking test_failure',
      '{"description": "3 unit tests in auth.test.ts are failing: testLogin, testLogout, testRefresh", "severity": "blocking", "category": "test_failure"}',
      "",
      '// API key found in source → blocking security',
      '{"description": "AWS access key found in src/config.ts: AKIA...", "severity": "blocking", "category": "security"}',
      "",
      '// TypeScript compilation error → blocking type_error',
      '{"description": "Type error in src/utils.ts:42 — Property \'name\' does not exist on type \'unknown\'", "severity": "blocking", "category": "type_error"}',
      "",
      '// Missing edge case handling → non_blocking incomplete',
      '{"description": "No error handling for network timeout in fetchUser()", "severity": "non_blocking", "category": "incomplete"}',
      "",
      '// Existing API broken → blocking regression',
      '{"description": "GET /api/users endpoint returns 500 after changes — was working before", "severity": "blocking", "category": "regression"}',
      '```',
    );

    return sections.join("\n");
  }
}
