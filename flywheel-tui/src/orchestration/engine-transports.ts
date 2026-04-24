import { randomUUID } from "node:crypto"
import type { Engine } from "./engines/core/types.js"
import type { AuthContext } from "../infra/auth/auth-context.js"
import type { DispatcherTransport } from "../workflows/dispatcher/transport.js"
import type { EvaluatorTransport } from "../workflows/evaluator/transport.js"
import { DispatcherDecisionHandoffSchema, handoffToDecision, type DispatcherInput } from "../workflows/dispatcher/schemas.js"
import type { DispatcherDecision } from "../infra/workflow-types.js"
import type { EvaluatorInput } from "../workflows/evaluator/schemas.js"
import type { EvaluatorResult } from "../infra/workflow-types.js"
import type { EmitFn } from "../infra/event-bus.js"
import { buildEvaluatorSystemPrompt, buildEvaluatorPrompt } from "../workflows/evaluator/prompts.js"
import { EvaluatorVerdictSchema } from "../workflows/evaluator/schemas.js"
import { buildDispatcherSystemPrompt } from "../workflows/dispatcher/system-prompt.js"
import { renderDispatcherHandoffInstruction } from "../workflows/queue/shared/handoff-render.js"
import { renderEvaluatorHandoffInstruction } from "../workflows/queue/shared/handoff-render.js"
import { buildInvocationHandoffPath, ensureSessionDir } from "../infra/paths.js"
import { Log } from "../infra/log.js"
import { toolActionsForProfile } from "./engines/core/tool-resolution.js"
import { invokeHandoffRunner } from "./handoff-runner.js"

const log = Log.create({ service: "engine-transports" })

interface EngineDispatcherTransportOptions {
  engine: Engine
  sessionId: string
  projectCwd: string
  model: string
  effort?: string
  emit: EmitFn
  workflowId: string
  auth: AuthContext
}

export function createEngineDispatcherTransport(
  opts: EngineDispatcherTransportOptions,
): DispatcherTransport {
  const { engine, sessionId, projectCwd, model, effort, emit, workflowId, auth } = opts
  const systemPrompt = buildDispatcherSystemPrompt()

  return {
    async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
      const invocationId = randomUUID()
      ensureSessionDir(sessionId, projectCwd)
      const handoffPath = buildInvocationHandoffPath("dispatcher", sessionId, invocationId, projectCwd)

      const userContent = `Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`
      const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath)
      const fullPrompt = `${userContent}\n\n${handoffInstruction}`

      const handoff = await invokeHandoffRunner({
        engine,
        model,
        auth,
        systemPrompt,
        effort,
        toolActions: toolActionsForProfile("dispatcher_handoff"),
        cwd: projectCwd,
        handoffPath,
        prompt: fullPrompt,
        handoffSchema: DispatcherDecisionHandoffSchema,
        onEvent: (event) => {
          emit("dispatcher:ndjson", { workflowId, ndjsonEvent: event })
        },
      })
      const decision = handoffToDecision(handoff)

      log.info("dispatcher invocation complete", { sessionId, invocationId })
      return decision
    },
  }
}

interface EngineEvaluatorTransportOptions {
  engine: Engine
  sessionId: string
  projectCwd: string
  model: string
  effort?: string
  systemPromptAddendum?: string
  emit: EmitFn
  workflowId: string
  auth: AuthContext
}

export function createEngineEvaluatorTransport(
  opts: EngineEvaluatorTransportOptions,
): EvaluatorTransport {
  const { engine, sessionId, projectCwd, model, effort, emit, workflowId, auth } = opts
  const systemPrompt = buildEvaluatorSystemPrompt(opts.systemPromptAddendum)

  return {
    async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
      const invocationId = randomUUID()
      ensureSessionDir(sessionId, projectCwd)
      const handoffPath = buildInvocationHandoffPath("evaluator", sessionId, invocationId, projectCwd)

      const userMessage = buildEvaluatorPrompt(input)
      const handoffInstruction = renderEvaluatorHandoffInstruction(handoffPath)
      const fullPrompt = `${userMessage}\n\n${handoffInstruction}`

      const verdict = await invokeHandoffRunner({
        engine,
        model,
        auth,
        systemPrompt,
        effort,
        toolActions: toolActionsForProfile("evaluator_verification"),
        cwd: projectCwd,
        handoffPath,
        prompt: fullPrompt,
        handoffSchema: EvaluatorVerdictSchema,
        onEvent: (event) => {
          emit("evaluator:ndjson", { workflowId, ndjsonEvent: event })
        },
      })

      log.info("evaluator invocation complete", { sessionId, invocationId, passed: verdict.passed })
      return verdict
    },
  }
}
