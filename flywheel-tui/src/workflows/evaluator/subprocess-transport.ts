/**
 * PooledSubprocessEvaluatorTransport — pool-based evaluator invocation via warm processes.
 *
 * Acquires a warm process from the pool, sends the evaluator prompt via stdin,
 * and reads the verdict from a handoff file. The evaluator has tool access
 * (Read, Bash, Write, Grep, Glob) so it can verify worker output.
 */

import type { EvaluatorInput } from "./schemas.js";
import type { EvaluatorResult } from "../../infra/workflow-types.js";
import type { EvaluatorTransport } from "./transport.js";
import { renderEvaluatorHandoffInstruction } from "../queue/shared/handoff-render.js";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "./schemas.js";
import { buildInvocationHandoffPath } from "../../infra/paths.js";

/** Evaluator system prompt — used as --system-prompt for Claude (separate for caching). */
const EVALUATOR_SYSTEM_PROMPT =
  "You are a verification agent. Read the worker's output, check each acceptance criterion, " +
  "and write a JSON verdict. You have tools — use them when a claim is worth verifying " +
  "(e.g., run the test command the worker reported, read a file the worker claims to have created). " +
  "Write the verdict file once you have enough evidence to decide.";

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

  // Verdict behavioral guidance — format details are in the handoff instruction that follows.
  sections.push(
    `## Verdict`,
    "",
    "Before writing your verdict:",
    "1. Check each acceptance criterion — is it met by the worker's output?",
    "2. If the worker claims tests pass, verify: check the test output summary, or run the command if in doubt.",
    "3. Check for regressions: did the worker break anything that was working before?",
    "",
    "Fail ONLY for hard evidence: tests actually failing, secrets in code, critical deliverables missing, or fundamentally wrong output.",
    "When in doubt, pass with suggestions. Revision loops are expensive.",
  );

  return sections.join("\n");
}

import {
  type PoolHandle,
  type PooledSpawnResult,
  type BasePooledTransportOptions,
  invokePooled,
} from "../shared/invoke-pooled.js";

interface PooledSubprocessEvaluatorTransportOptions extends BasePooledTransportOptions {
  /** Optional addendum appended to the evaluator system prompt. */
  systemPromptAddendum?: string;
}

export class PooledSubprocessEvaluatorTransport implements EvaluatorTransport {
  private readonly opts: BasePooledTransportOptions;
  private readonly systemPrompt: string;

  constructor(options: PooledSubprocessEvaluatorTransportOptions) {
    this.opts = options;
    this.systemPrompt = options.systemPromptAddendum
      ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${options.systemPromptAddendum}`
      : EVALUATOR_SYSTEM_PROMPT;
  }

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    const userMessage = buildEvaluatorPrompt(input);

    return invokePooled<EvaluatorVerdict, EvaluatorResult>(
      this.opts.pool,
      {
        role: "evaluator",
        buildHandoffPath: (sessionId, invocationId, baseDir) =>
          buildInvocationHandoffPath("evaluator", sessionId, invocationId, baseDir),
        buildFullPrompt: (handoffPath) => {
          const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
          return `${userMessage}\n\n${handoffInstruction}`;
        },
        systemPrompt: this.systemPrompt,
        handoffSchema: EvaluatorVerdictSchema,
        // Identity — the verdict schema already produces the result type.
        // mapResult exists for the dispatcher's sake (it defaults evaluation_criteria).
        mapResult: (verdict): EvaluatorResult => verdict,
      },
      this.opts,
    );
  }
}
