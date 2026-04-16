/**
 * Engine-backed transport implementations for dispatcher and evaluator.
 *
 * These implement the DI interfaces from workflows/ (DispatcherTransport,
 * EvaluatorTransport) using engine.createRunner() instead of warm process
 * pools. Both engines (Claude CLI, harness in-process) work
 * transparently through the Engine abstraction.
 */

import { randomUUID } from "node:crypto"
import type { Engine } from "./engines/core/types.js"
import type { DispatcherTransport } from "../workflows/dispatcher/transport.js"
import type { EvaluatorTransport } from "../workflows/evaluator/transport.js"
import type { DispatcherInput } from "../workflows/dispatcher/schemas.js"
import type { DispatcherDecision } from "../infra/workflow-types.js"
import type { EvaluatorInput } from "../workflows/evaluator/schemas.js"
import type { EvaluatorResult } from "../infra/workflow-types.js"
import type { EmitFn } from "../infra/event-bus.js"
import { EVALUATOR_SYSTEM_PROMPT, buildEvaluatorPrompt } from "../workflows/evaluator/prompts.js"
import { DispatcherDecisionHandoffSchema } from "../workflows/dispatcher/schemas.js"
import { EvaluatorVerdictSchema } from "../workflows/evaluator/schemas.js"
import { buildDispatcherSystemPrompt } from "../workflows/dispatcher/system-prompt.js"
import { renderDispatcherHandoffInstruction } from "../workflows/queue/shared/handoff-render.js"
import { renderEvaluatorHandoffInstruction } from "../workflows/queue/shared/handoff-render.js"
import { buildInvocationHandoffPath, ensureSessionDir } from "../infra/paths.js"
import { readHandoff } from "../workflows/queue/shared/handoff-reader.js"
import { Log } from "../infra/log.js"

const log = Log.create({ service: "engine-transports" })

// --- Dispatcher ---

interface EngineDispatcherTransportOptions {
  engine: Engine
  sessionId: string
  projectCwd: string
  model: string
  effort?: string
  emit: EmitFn
  workflowId: string
}

export function createEngineDispatcherTransport(
  opts: EngineDispatcherTransportOptions,
): DispatcherTransport {
  const { engine, sessionId, projectCwd, model, effort, emit, workflowId } = opts
  const systemPrompt = buildDispatcherSystemPrompt()

  return {
    async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
      const invocationId = randomUUID()
      ensureSessionDir(sessionId, projectCwd)
      const handoffPath = buildInvocationHandoffPath("dispatcher", sessionId, invocationId, projectCwd)

      const userContent = `Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`
      const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath)
      const fullPrompt = `${userContent}\n\n${handoffInstruction}`

      const runner = engine.createRunner({
        model,
        systemPrompt,
        effort,
        tools: ["Write"],
        cwd: projectCwd,
        handoffPath,
        onEvent: (event) => {
          emit("dispatcher:ndjson", { workflowId, ndjsonEvent: event })
        },
      })

      runner.send(fullPrompt)
      await runner.done

      const handoff = await readHandoff(handoffPath, DispatcherDecisionHandoffSchema)
      const decision: DispatcherDecision = {
        ...handoff,
        evaluation_criteria: handoff.evaluation_criteria
          ?? { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
        // Zod .default() fills task at runtime, but .omit().extend() loses the
        // output-type narrowing — re-spread worker_config to satisfy the compiler.
        worker_config: handoff.worker_config ? {
          ...handoff.worker_config,
          tool_scoping: handoff.worker_config.tool_scoping
            ? { ...handoff.worker_config.tool_scoping, task: handoff.worker_config.tool_scoping.task ?? false }
            : undefined,
        } : undefined,
      }

      log.info("dispatcher invocation complete", { sessionId, invocationId })
      return decision
    },
  }
}

// --- Evaluator ---

interface EngineEvaluatorTransportOptions {
  engine: Engine
  sessionId: string
  projectCwd: string
  model: string
  effort?: string
  systemPromptAddendum?: string
  emit: EmitFn
  workflowId: string
}

export function createEngineEvaluatorTransport(
  opts: EngineEvaluatorTransportOptions,
): EvaluatorTransport {
  const { engine, sessionId, projectCwd, model, effort, emit, workflowId } = opts
  const systemPrompt = opts.systemPromptAddendum
    ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${opts.systemPromptAddendum}`
    : EVALUATOR_SYSTEM_PROMPT

  return {
    async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
      const invocationId = randomUUID()
      ensureSessionDir(sessionId, projectCwd)
      const handoffPath = buildInvocationHandoffPath("evaluator", sessionId, invocationId, projectCwd)

      const userMessage = buildEvaluatorPrompt(input)
      const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath)
      const fullPrompt = `${userMessage}\n\n${handoffInstruction}`

      const runner = engine.createRunner({
        model,
        systemPrompt,
        effort,
        tools: ["Read", "Bash", "Write", "Grep", "Glob"],
        cwd: projectCwd,
        handoffPath,
        onEvent: (event) => {
          emit("evaluator:ndjson", { workflowId, ndjsonEvent: event })
        },
      })

      runner.send(fullPrompt)
      await runner.done

      const verdict = await readHandoff(handoffPath, EvaluatorVerdictSchema)

      log.info("evaluator invocation complete", { sessionId, invocationId, passed: verdict.passed })
      return verdict
    },
  }
}
