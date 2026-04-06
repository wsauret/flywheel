/**
 * PooledSubprocessEvaluatorTransport — pool-based evaluator invocation via warm processes.
 *
 * Acquires a warm process from the pool, sends the evaluator prompt via stdin,
 * and reads the verdict from a handoff file. The evaluator has tool access
 * (Read, Bash, Write, Grep, Glob) so it can verify worker output.
 */

import type { EvaluatorInput, EvaluatorResult } from "./schemas.js";
import type { EvaluatorTransport } from "./transport.js";
import { renderEvaluatorHandoffInstruction } from "../queue/shared/handoff-render.js";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "./schemas.js";
import { buildEvaluatorHandoffPath } from "../../infra/paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Evaluator system prompt — used as --system-prompt for Claude (separate for caching). */
const EVALUATOR_SYSTEM_PROMPT =
  "You are a 60-second verification agent. Read the input, form a verdict, write the JSON file. " +
  "You have tools but should almost never need them. Only use a tool if you see a specific red flag " +
  "that requires one quick check to confirm. Write the verdict file IMMEDIATELY — every second counts.";

// ---------------------------------------------------------------------------
// Shared prompt builder
// ---------------------------------------------------------------------------

/** Build the evaluator user-message from structured input. Shared by both transport variants. */
function buildEvaluatorPrompt(input: EvaluatorInput): string {
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

// ---------------------------------------------------------------------------
// PooledSubprocessEvaluatorTransport — uses warm pool instead of fresh spawns
// ---------------------------------------------------------------------------

import {
  type PoolHandle,
  type PooledSpawnResult,
  invokePooled,
} from "../shared/invoke-pooled.js";

export type { PoolHandle, PooledSpawnResult };

export interface PooledSubprocessEvaluatorTransportOptions {
  /** Warm pool handle — injected by the orchestration layer. */
  pool: PoolHandle;
  /**
   * Format a prompt string as an NDJSON stdin message.
   * Injected to avoid importing from orchestration/engines/subprocess/.
   */
  formatStdinMessage: (text: string) => string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId: string;
  /** Project base directory for path resolution. */
  baseDir: string;
  /** Optional addendum appended to the evaluator system prompt. */
  systemPromptAddendum?: string;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Called with each decoded stdout chunk as it arrives from the subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the subprocess. */
  onStderr?: (chunk: string) => void;
}

export class PooledSubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly pool: PoolHandle;
  private readonly formatStdinMsg: (text: string) => string;
  private readonly sessionId: string;
  private readonly baseDir: string;
  private readonly systemPrompt: string;
  private readonly logBaseDir?: string;
  private readonly onStdout?: (chunk: string) => void;
  private readonly onStderr?: (chunk: string) => void;

  constructor(options: PooledSubprocessEvaluatorTransportOptions) {
    this.pool = options.pool;
    this.formatStdinMsg = options.formatStdinMessage;
    this.sessionId = options.sessionId;
    this.baseDir = options.baseDir;
    this.logBaseDir = options.logBaseDir;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;

    this.systemPrompt = options.systemPromptAddendum
      ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${options.systemPromptAddendum}`
      : EVALUATOR_SYSTEM_PROMPT;
  }

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    const userMessage = buildEvaluatorPrompt(input);

    return invokePooled<EvaluatorVerdict, EvaluatorResult>(
      this.pool,
      {
        role: "evaluator",
        buildHandoffPath: buildEvaluatorHandoffPath,
        buildFullPrompt: (handoffPath) => {
          const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
          return `${userMessage}\n\n${handoffInstruction}`;
        },
        systemPrompt: this.systemPrompt,
        handoffSchema: EvaluatorVerdictSchema,
        mapResult: (verdict) => ({
          passed: verdict.passed,
          reasoning: verdict.reasoning,
          suggestions: verdict.suggestions,
          confidence: verdict.confidence,
          feedback: verdict.feedback,
          files_to_review: verdict.files_to_review,
          issues: verdict.issues,
        }),
      },
      {
        sessionId: this.sessionId,
        baseDir: this.baseDir,
        formatStdinMessage: this.formatStdinMsg,
        logBaseDir: this.logBaseDir,
        onStdout: this.onStdout,
        onStderr: this.onStderr,
      },
    );
  }
}
