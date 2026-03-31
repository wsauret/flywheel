/**
 * Queue orchestrator — pure functions for resolving transports and building
 * executor dependencies. Extracted from flywheel-shell.tsx to reduce its size.
 *
 * These functions take all dependencies as parameters (no SolidJS signals).
 */

import { randomUUID } from "node:crypto"
import { autoDetectTransport } from "../../dispatcher/auto-detect"
import { createEvaluatorTransport } from "../../evaluator/create-transport"
import { createStepDispatcher, type StepDispatchContext } from "../../queue/step-dispatcher"
import { createAgentEvaluatorFn } from "../../evaluator/create-agent-evaluator"
import { readHandoff } from "../../queue/shared/handoff-reader"
import { WorkerHandoffSchema } from "../../queue/shared/handoff-schemas"
import { createContextAccumulator } from "../../queue/context-accumulator"
import { createPlanIntegrationHook, type ConfirmBeforeInsert } from "../../queue/steps/plan-consolidate/hooks"
import { createCompositeHook } from "../../queue/shared/hooks"
import { createReviewFixInjectionHook } from "../../queue/steps/review-consolidate/hooks"
import { createReviewP3TriageHook } from "../../queue/steps/review-dispatch/hooks"
import { createSprintQueueHandler, type SprintQueueHandler } from "../../queue/steps/sprint-work/hooks"
import { createDebugQueueHandler } from "../../queue/steps/debug-fix/hooks"
import { runVerificationScript } from "../../queue/steps/sprint-work/verification-runner"
import "../../queue/steps/register-all"
import { buildScaffolding, type ScaffoldingPaths } from "../../queue/shared/scaffolding"
import {
  sessionDir,
  buildWorkerHandoffPath,
  ensureSessionDir,
} from "../../config/paths"
import { resolveModels } from "../../config/loader"
import { createFlywheelEmitter } from "../../events/event-bus"
import { formatClaudeStdinMessage } from "../../worker/stdin-format"
import { Log } from "../../utils/log"
import { ContextIndexer } from "../../memory/indexer"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { EventBus } from "../../events/event-bus"
import type { Queue } from "../../queue/types"
import type { StdinHandle } from "../../worker/spawner"
import type { QuestionService } from "../../queue/question-service"
import type { WorkflowSession } from "../session/workflow-session"

const log = Log.create({ service: "shell" })

// ── resolveTransports ──

/**
 * Resolve dispatcher and evaluator transports for queue execution.
 * Shared between startQueueExecution and resumeSession queue paths.
 */
export async function resolveTransports(deps: WorkflowDeps, eventBus: EventBus, workflowIdRef: { current: string }, logBaseDir: string, sessionId?: string, baseDir?: string, evaluatorSystemPromptAddendum?: string) {
  const engineName = deps.config.engine

  let dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined
  try {
    const { resolveModels } = await import("../../config/loader")
    const { dispatcherModel } = resolveModels(deps.config)
    const resolved = await autoDetectTransport({
      spawner: deps.spawner,
      engineName,
      dispatcherModel,
      onStdout: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
      onStderr: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
      logBaseDir,
      sessionId,
      baseDir,
    })
    dispatcherTransport = resolved.transport
    log.info("queue dispatcher transport resolved", { label: resolved.label, engine: engineName })
  } catch (err) {
    log.warn("queue dispatcher transport auto-detect failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  let evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined
  if (!deps.config.skip_evaluation) {
    try {
      const { resolveModels: resolveModelsForEval } = await import("../../config/loader")
      const { dispatcherModel: evalModel } = resolveModelsForEval(deps.config)
      evaluatorTransport = await createEvaluatorTransport({
        spawner: deps.spawner,
        engineName,
        evaluatorModel: evalModel,
        onStdout: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
        onStderr: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
        logBaseDir,
        sessionId,
        baseDir,
        systemPromptAddendum: evaluatorSystemPromptAddendum,
      })
      log.info("queue evaluator transport created", { engine: engineName })
    } catch (err) {
      log.warn("queue evaluator transport creation failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { dispatcherTransport, evaluatorTransport }
}

// ── buildExecutorDeps ──

export interface BuildExecutorDepsOpts {
  deps: WorkflowDeps;
  emitter: ReturnType<typeof createFlywheelEmitter>;
  workflowIdRef: { current: string };
  dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined;
  evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined;
  contextIndexer: ContextIndexer;
  projectCwd: string;
  sessionObjective: string | undefined;
  queue: Queue;
  /** Session ID for session-scoped file paths. */
  sessionId: string;
  /** Mutable ref to store the active worker's stdin handle for mid-execution injection. */
  stdinHandleRef?: { current: StdinHandle | null };
  /** Pre-seed context accumulator with fixture handoff (for /test command). */
  seedHandoff?: Record<string, unknown> | null;
  /** Question service for P3 triage hook (from activeQuestionWiring?.service). */
  questionService?: QuestionService | null;
  /** When false, P3 triage uses auto-directive instead of interactive question. */
  reviewTriageInteractive?: boolean;
  /** Optional callback for interactive plan confirmation (HITL). */
  confirmBeforeInsert?: ConfirmBeforeInsert;
  /** Setter for TUI queue step state (SolidJS signal setter passed from shell). */
  setShellQueueSteps: (updater: any) => void;
  /** Mutable ref tracking captured worker session ID for resume/interrupt. */
  capturedWorkerSessionId: { current: string | undefined };
  /** Mutable ref for pending injection message at turn boundaries. */
  pendingInjection: { current: string | null };
  /** Ref to the active workflow session (for event bus access in turn-complete callback). */
  activeSessionRef: { current: WorkflowSession | null };
}

/**
 * Build the shared executor dependencies (dispatcher, accumulator, evaluator,
 * hooks, worker callback, handoff reader) used by both startQueueExecution
 * and resumeSession. Eliminates ~150 lines of duplication between the two paths.
 */
export function buildExecutorDeps(opts: BuildExecutorDepsOpts) {
  const {
    deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
    contextIndexer, projectCwd, sessionObjective, queue, stdinHandleRef,
    seedHandoff, sessionId: execSessionId,
    questionService, reviewTriageInteractive, confirmBeforeInsert,
    setShellQueueSteps,
    capturedWorkerSessionId, pendingInjection, activeSessionRef,
  } = opts
  const { dispatcherModel, workerModel } = resolveModels(deps.config)

  // Build real StepDispatcher if transport is available
  const realDispatcher = dispatcherTransport
    ? createStepDispatcher({
        transport: dispatcherTransport,
        emitter,
        workflowId: workflowIdRef.current,
        configContext: {
          maxEvalCycles: deps.config.max_revisions ?? 1,
          worktreePath: projectCwd,
          projectCwd,
          workerModel: workerModel ?? "sonnet",
          dispatcherModel: dispatcherModel ?? "sonnet",
        },
        sessionBudget: { wall_clock_deadline: null, invocations_remaining: null, token_budget_remaining: null },
        availableContext: contextIndexer.getRelevantContext({ stepType: "plan", stepDescription: sessionObjective ?? "" }),
        sessionObjective,
      })
    : null

  // Real context accumulator (windowed detail strategy)
  const contextAccumulator = createContextAccumulator()

  // Seed accumulator with fixture handoff data (for /test command)
  if (seedHandoff) {
    contextAccumulator.accumulate(seedHandoff)
  }

  // Agent-based evaluator (if evaluation not skipped and transport available)
  // Verify steps skip evaluation entirely — they use direct verification scripts.
  const baseEvaluator = !deps.config.skip_evaluation && evaluatorTransport
    ? createAgentEvaluatorFn({ transport: evaluatorTransport })
    : null
  const evaluator = baseEvaluator
    ? async (step: import("../../queue/types").Step, workerOutput: string, evaluationCriteria?: unknown | null, handoffData?: Record<string, unknown> | null) => {
        // Skip evaluation for verify steps (sprint verification is handled by the sprint handler)
        if (step.type === "verify") {
          return { passed: true, skipped: true, transportError: false, reason: null, feedback: null, suggestions: [], cyclesUsed: 0 }
        }
        return baseEvaluator(step, workerOutput, evaluationCriteria, handoffData)
      }
    : null

  // Sprint queue handler: wire when queue contains verify steps but NOT debug steps
  // (debug queues also have verify steps but use the debug-loop handler instead)
  const isDebugQueue = queue.steps.some(s => s.type === "debug")
  const isSprintQueue = !isDebugQueue && queue.steps.some(s => s.type === "verify")
  let sprintHandler: SprintQueueHandler | null = null
  if (isSprintQueue) {
    sprintHandler = createSprintQueueHandler({
      taskDescription: sessionObjective ?? "",
      projectCwd,
      sprintConfig: {
        max_iterations: deps.config.sprint?.max_iterations ?? 5,
        verification_timeout_ms: deps.config.sprint?.verification_timeout_ms ?? 30000,
        escalate_to_full: deps.config.sprint?.escalate_to_full ?? true,
        escalate_on_stuck: deps.config.sprint?.escalate_on_stuck ?? false,
      },
      emitter,
      workflowId: workflowIdRef.current,
      runVerification: runVerificationScript,
      readHandoff: async (handoffPath: string) => {
        if (!handoffPath) return null
        try {
          const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
          return handoff as unknown as Record<string, unknown>
        } catch { return null }
      },
    })
  }

  // Debug queue handler (isDebugQueue already computed above for sprint exclusion)
  const debugHandler = isDebugQueue ? createDebugQueueHandler() : null

  // Plan integration hook + review fix injection + P3 triage + debug hook + sprint hook + TUI step insertion composite hook
  const planIntegrationHook = createPlanIntegrationHook(projectCwd, execSessionId, confirmBeforeInsert)
  const reviewFixInjectionHook = createReviewFixInjectionHook()
  const triageQS = reviewTriageInteractive === false ? null : (questionService ?? null)
  const reviewP3TriageHook = createReviewP3TriageHook({ questionService: triageQS })
  const compositeHook = createCompositeHook([
    planIntegrationHook,
    reviewFixInjectionHook,
    reviewP3TriageHook,
    debugHandler?.onStepCompleted ?? null,
    sprintHandler?.onStepCompleted ?? null,
    async (step, status, q, _handoffData) => {
      // Refresh TUI step list when plan, review, or verify steps complete
      // (plan integration inserts work steps; review-fix-injection may insert a fix step;
      // sprint handler inserts retry pairs or escalation steps)
      if (status === "completed" && (step.type === "plan" || step.type === "review" || step.type === "verify")) {
        const updatedQueueStepStates = q.steps.map(s => ({
          id: s.id,
          type: s.type,
          title: s.title,
          status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
        }))
        setShellQueueSteps(updatedQueueStepStates)
      }
      // Also refresh on failed verify/work steps in sprint or debug (retry pairs get inserted)
      if ((isSprintQueue || isDebugQueue) && status === "failed" && (step.type === "work" || step.type === "verify" || step.type === "debug")) {
        const updatedQueueStepStates = q.steps.map(s => ({
          id: s.id,
          type: s.type,
          title: s.title,
          status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
        }))
        setShellQueueSteps(updatedQueueStepStates)
      }
      return { continueExecution: false }
    },
  ])

  // Dispatcher callback: real dispatcher with fallback to step metadata
  // Sprint work steps use the sprint handler's prompt builder for iteration-aware prompts
  const dispatcherFn = async (step: import("../../queue/types").Step, context: { previousHandoff?: unknown; previousAssessment?: unknown; hitlResponse?: unknown }) => {
    // Sprint work steps: use sprint handler's prompt builder (iteration-aware)
    if (sprintHandler && step.type === "work" && isSprintQueue) {
      const sprintPrompt = sprintHandler.buildWorkStepPrompt(step)
      return { prompt: sprintPrompt, evaluationCriteria: null }
    }

    // Verify steps: no dispatcher needed (they run verification scripts directly)
    if (step.type === "verify") {
      return { prompt: "", evaluationCriteria: null }
    }

    if (realDispatcher) {
      try {
        const dispatchContext: StepDispatchContext = {
          accumulatedContext: contextAccumulator.getContext() as any,
          previousHandoff: (context.previousHandoff as Record<string, unknown>) ?? null,
          previousAssessment: (context.previousAssessment as any) ?? null,
          hitlResponse: (context.hitlResponse as string) ?? null,
        }
        const decision = await realDispatcher.dispatch(step, queue, dispatchContext)
        return {
          prompt: decision.taskContent,
          evaluationCriteria: decision.evaluationCriteria,
        }
      } catch (err) {
        log.warn("real dispatcher failed, falling back to step metadata", {
          stepId: step.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const parts = [step.title]
    if (step.description) parts.push(step.description)
    if (step.acceptanceCriteria?.length) {
      parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(c => `- ${c}`))
    }
    if (step.evaluationCriteria) parts.push(`Evaluation: ${step.evaluationCriteria}`)
    return { prompt: parts.join("\n"), evaluationCriteria: null }
  }

  // Worker callback: spawn engine process (or run verification script for verify steps)
  const useStdinPipe = deps.engine.metadata.supportsStreamingInput
  const workerFn = async (step: import("../../queue/types").Step, prompt: string) => {
    // Sprint verify steps: run verification script directly (no dispatcher/worker/evaluator)
    if (step.type === "verify" && sprintHandler) {
      const startTime = Date.now()
      const verifyResult = await sprintHandler.executeVerifyStep(step, null)
      // Write verification result as a pseudo-handoff so the sprint handler
      // can read it back in onStepCompleted
      const invocationId = randomUUID()
      const handoffPath = buildWorkerHandoffPath(execSessionId, step.type, step.id, projectCwd)
      ensureSessionDir(execSessionId, projectCwd)
      try {
        const verifySummary = verifyResult.passed
          ? `Verification passed (exit code ${verifyResult.exitCode ?? 0}).`
          : `Verification failed: ${verifyResult.error ?? `exit code ${verifyResult.exitCode ?? 1}`}.`
        const handoffData = {
          summary: verifySummary.replace(/[\n\r]/g, " ").slice(0, 500),
          verificationResult: verifyResult,
        }
        await Bun.write(handoffPath, JSON.stringify(handoffData, null, 2))
      } catch (err) {
        log.warn("failed to write verify handoff", { error: err instanceof Error ? err.message : String(err) })
      }
      // Emit output for TUI display
      const statusLabel = verifyResult.passed ? "✅ PASSED" : "❌ FAILED"
      emitter.workerOutput(workflowIdRef.current, "stderr",
        `Verification ${statusLabel}${verifyResult.exitCode !== undefined ? ` (exit code ${verifyResult.exitCode})` : ""}\n`,
        "verification-runner")
      if (verifyResult.stdout) {
        emitter.workerOutput(workflowIdRef.current, "stdout", verifyResult.stdout, "verification-runner")
      }
      if (verifyResult.stderr) {
        emitter.workerOutput(workflowIdRef.current, "stderr", verifyResult.stderr, "verification-runner")
      }
      if (verifyResult.error) {
        emitter.workerOutput(workflowIdRef.current, "stderr", `Error: ${verifyResult.error}\n`, "verification-runner")
      }
      return {
        output: verifyResult.passed ? "completed" : "verification failed",
        handoffPath,
        durationMs: Date.now() - startTime,
      }
    }

    const invocationId = randomUUID()

    // Compute handoff path BEFORE spawning — session-scoped with meaningful name
    const handoffPath = buildWorkerHandoffPath(execSessionId, step.type, step.id, projectCwd)
    ensureSessionDir(execSessionId, projectCwd)

    // Build session-scoped paths for scaffolding
    const scaffoldingPaths: ScaffoldingPaths = {
      handoffPath,
      planPath: `${sessionDir(execSessionId)}/plan.json`,
      researchPath: `${sessionDir(execSessionId)}/research.md`,
      reviewPath: `${sessionDir(execSessionId)}/review.md`,
    }

    // Build deterministic scaffolding (preamble before task_content, postamble after)
    const scaffolding = buildScaffolding(step, scaffoldingPaths)
    const parts: string[] = []
    if (scaffolding.preamble) parts.push(scaffolding.preamble)
    parts.push(prompt)
    if (scaffolding.postamble) parts.push(scaffolding.postamble)
    const fullPrompt = parts.join("\n\n")

    const engineCmd = deps.engine.buildCommand({
      prompt: fullPrompt,
      model: deps.config.worker?.model ?? deps.config.model,
      toolScoping: step.toolScoping ?? undefined,
    })
    const startTime = Date.now()
    const rawStdinContent = engineCmd.stdinPrompt
      ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
      : undefined
    // NDJSON-wrap stdin content when using streaming pipe (Claude's --input-format stream-json)
    const stdinContent = useStdinPipe && rawStdinContent
      ? formatClaudeStdinMessage(rawStdinContent)
      : rawStdinContent
    // Turn-complete callback: when the worker finishes a turn (result event)
    // and the stdin pipe is still open, either inject a pending message or
    // close the pipe to let the step advance.
    const onTurnComplete = useStdinPipe ? (sessionId: string | undefined) => {
      // Capture session ID for --resume/--session after interrupt
      capturedWorkerSessionId.current = sessionId
      // Check for pending injection (user typed while worker was running)
      if (pendingInjection.current && stdinHandleRef?.current?.isOpen) {
        const message = pendingInjection.current
        pendingInjection.current = null
        const written = stdinHandleRef.current.write(formatClaudeStdinMessage(message))
        if (written) {
          log.info("turn-boundary injection sent to worker", { length: message.length })
          // Emit event for TUI display
          if (activeSessionRef.current) {
            activeSessionRef.current.eventBus.emit({
              type: "worker:injected",
              workflowId: workflowIdRef.current,
              message,
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          log.warn("turn-boundary injection failed — pipe closed")
        }
      } else {
        // No pending injection — close the pipe to let the step advance
        stdinHandleRef?.current?.close()
      }
    } : undefined

    const spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: projectCwd,
      invocationId,
      sessionId: execSessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      onTurnComplete,
      onSessionId: (sessionId) => {
        capturedWorkerSessionId.current = sessionId
      },
      onStdout: (chunk) => {
        emitter.workerOutput(workflowIdRef.current, "stdout", chunk, deps.engine.metadata.id)
      },
      onStderr: (chunk) => {
        emitter.workerOutput(workflowIdRef.current, "stderr", chunk, deps.engine.metadata.id)
      },
    })
    // Expose stdinHandle for mid-execution injection (user steering)
    if (stdinHandleRef && spawnResult.stdinHandle) {
      stdinHandleRef.current = spawnResult.stdinHandle
    }
    try {
      const workerResult = await spawnResult.result
      // Capture session ID from worker result (fallback for non-streaming engines)
      if (workerResult.sessionId) {
        capturedWorkerSessionId.current = workerResult.sessionId
      }
      return {
        output: workerResult.exitCode === 0 ? "completed" : (workerResult.failure?.message ?? "failed"),
        handoffPath: workerResult.handoffPath ?? "",
        durationMs: Date.now() - startTime,
        sessionId: workerResult.sessionId,
      }
    } finally {
      // Clear handle when worker finishes (pipe is closed)
      if (stdinHandleRef) {
        stdinHandleRef.current = null
      }
    }
  }

  // Handoff reader callback
  const handoffReader = async (handoffPath: string) => {
    if (!handoffPath) return null
    try {
      const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
      return handoff as unknown as Record<string, unknown>
    } catch (err) {
      log.warn("handoff read failed, continuing without handoff", {
        path: handoffPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  return {
    contextAccumulator,
    evaluator,
    compositeHook,
    dispatcherFn,
    workerFn,
    handoffReader,
    sprintHandler,
  }
}
