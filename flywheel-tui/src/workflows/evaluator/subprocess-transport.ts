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
 * Delegates shared subprocess logic (engine resolution, binary check, retry loop,
 * handoff reading, subprocess logging) to subprocess-transport-base.
 */

import type { EvaluatorInput, EvaluatorResult } from "./schemas.js";
import type { EvaluatorTransport } from "./transport.js";
import { renderEvaluatorHandoffInstruction } from "../queue/shared/handoff-render.js";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "./schemas.js";
import { buildEvaluatorHandoffPath } from "../../infra/paths.js";
import {
  type SubprocessTransportBaseOptions,
  type ResolvedTransportBase,
  resolveTransportBase,
  invokeSubprocess,
} from "../shared/subprocess-transport-base.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Evaluator system prompt — used as --system-prompt for Claude (separate for caching). */
const EVALUATOR_SYSTEM_PROMPT =
  "You are a 60-second verification agent. Read the input, form a verdict, write the JSON file. " +
  "You have tools but should almost never need them. Only use a tool if you see a specific red flag " +
  "that requires one quick check to confirm. Write the verdict file IMMEDIATELY — every second counts.";

// ---------------------------------------------------------------------------
// SubprocessEvaluatorTransport
// ---------------------------------------------------------------------------

export interface SubprocessEvaluatorTransportOptions extends SubprocessTransportBaseOptions {
  /** Optional addendum appended to the evaluator system prompt (e.g. sprint adversarial instructions). */
  systemPromptAddendum?: string;
  /** Injected command builder — orchestration provides the engine-specific implementation. */
  buildCommand: (opts: { prompt: string; systemPrompt: string; tierConfig?: { model?: string; effort?: string } }) => { command: string; args: string[]; stdinPrompt: boolean };
}

export class SubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly base: ResolvedTransportBase;
  private readonly systemPrompt: string;
  private readonly buildCommand: SubprocessEvaluatorTransportOptions["buildCommand"];

  constructor(options: SubprocessEvaluatorTransportOptions) {
    this.base = resolveTransportBase(options);
    this.buildCommand = options.buildCommand;

    this.systemPrompt = options.systemPromptAddendum
      ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${options.systemPromptAddendum}`
      : EVALUATOR_SYSTEM_PROMPT;
  }

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    const userMessage = this.buildPrompt(input);

    return invokeSubprocess<EvaluatorVerdict, EvaluatorResult>(this.base, {
      role: "evaluator",
      buildHandoffPath: buildEvaluatorHandoffPath,
      buildFullPrompt: (handoffPath) => {
        const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
        return `${userMessage}\n\n${handoffInstruction}`;
      },
      systemPrompt: this.systemPrompt,
      buildEngineCommand: (prompt, sysPrompt, tierConfig) =>
        this.buildCommand({ prompt, systemPrompt: sysPrompt, tierConfig }),
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
    });
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
