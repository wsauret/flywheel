/**
 * Pool-aware DispatcherTransport and EvaluatorTransport for the Claude engine.
 *
 * These bypass the Engine abstraction to work directly with pre-warmed
 * subprocesses. The pool is a Claude-specific optimization — other engines
 * use the generic engine-transports.ts which calls engine.createRunner().
 */

import type { DispatcherInput } from "../../../../../workflows/dispatcher/schemas.js";
import type { DispatcherDecision } from "../../../../../infra/workflow-types.js";
import type { DispatcherTransport } from "../../../../../workflows/dispatcher/transport.js";
import type { EvaluatorInput } from "../../../../../workflows/evaluator/schemas.js";
import type { EvaluatorResult } from "../../../../../infra/workflow-types.js";
import type { EvaluatorTransport } from "../../../../../workflows/evaluator/transport.js";
import { EVALUATOR_SYSTEM_PROMPT, buildEvaluatorPrompt } from "../../../../../workflows/evaluator/prompts.js";
import { DispatcherDecisionHandoffSchema, type DispatcherDecisionHandoff } from "../../../../../workflows/dispatcher/schemas.js";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "../../../../../workflows/evaluator/schemas.js";
import { buildDispatcherSystemPrompt } from "../../../../../workflows/dispatcher/system-prompt.js";
import { renderDispatcherHandoffInstruction } from "../../../../../workflows/queue/shared/handoff-render.js";
import { renderEvaluatorHandoffInstruction } from "../../../../../workflows/queue/shared/handoff-render.js";
import { buildInvocationHandoffPath } from "../../../../../infra/paths.js";
import { invokePooled } from "./invoke-pooled.js";
import type { WarmPool } from "./warm-pool.js";
import type { SpawnResult } from "../subprocess/spawner.js";

// --- Dispatcher ---

interface PooledDispatcherOptions {
  pool: WarmPool<SpawnResult>;
  sessionId: string;
  projectCwd: string;
}

export function createPooledDispatcherTransport(
  opts: PooledDispatcherOptions,
): DispatcherTransport {
  const systemPrompt = buildDispatcherSystemPrompt();

  return {
    async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
      const userContent = `Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

      return invokePooled<DispatcherDecisionHandoff, DispatcherDecision>(
        opts.pool,
        {
          role: "dispatcher",
          buildHandoffPath: (sessionId, invocationId, baseDir) =>
            buildInvocationHandoffPath("dispatcher", sessionId, invocationId, baseDir),
          buildFullPrompt: (handoffPath) => {
            const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
            return `${userContent}\n\n${handoffInstruction}`;
          },
          systemPrompt,
          handoffSchema: DispatcherDecisionHandoffSchema,
          mapResult: (handoff): DispatcherDecision => ({
            ...handoff,
            evaluation_criteria: handoff.evaluation_criteria
              ?? { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
            worker_config: handoff.worker_config ? {
              ...handoff.worker_config,
              tool_scoping: handoff.worker_config.tool_scoping
                ? { ...handoff.worker_config.tool_scoping, task: handoff.worker_config.tool_scoping.task ?? false }
                : undefined,
            } : undefined,
          }),
        },
        { sessionId: opts.sessionId, baseDir: opts.projectCwd },
      );
    },
  };
}

// --- Evaluator ---

interface PooledEvaluatorOptions {
  pool: WarmPool<SpawnResult>;
  sessionId: string;
  projectCwd: string;
  systemPromptAddendum?: string;
}

export function createPooledEvaluatorTransport(
  opts: PooledEvaluatorOptions,
): EvaluatorTransport {
  const systemPrompt = opts.systemPromptAddendum
    ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${opts.systemPromptAddendum}`
    : EVALUATOR_SYSTEM_PROMPT;

  return {
    async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
      const userMessage = buildEvaluatorPrompt(input);

      return invokePooled<EvaluatorVerdict, EvaluatorResult>(
        opts.pool,
        {
          role: "evaluator",
          buildHandoffPath: (sessionId, invocationId, baseDir) =>
            buildInvocationHandoffPath("evaluator", sessionId, invocationId, baseDir),
          buildFullPrompt: (handoffPath) => {
            const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath);
            return `${userMessage}\n\n${handoffInstruction}`;
          },
          systemPrompt,
          handoffSchema: EvaluatorVerdictSchema,
          mapResult: (verdict): EvaluatorResult => verdict,
        },
        { sessionId: opts.sessionId, baseDir: opts.projectCwd },
      );
    },
  };
}
