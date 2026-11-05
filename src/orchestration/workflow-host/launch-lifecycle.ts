import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { readTerminalHandoff, readWorkflowCompletionEvidence, workflowCompletionContent, workflowStopContent } from "../../workflows/output-contract/workflow-completion.js"
import type { BackgroundKillSource, BackgroundWorkResult, BackgroundWorkTracking, ChildInterruption } from "../agent-runtime/background-work.js"
import { parentHost } from "../session/live-session-control.js"
import { textField } from "../../infra/output/json-field.js"
import { readToolExecution } from "../session/tool-execution-projection.js"
import { workflowCallSource, workflowSourceLabel } from "../../infra/tools/workflow-call-source.js"
import type { StoppedBy } from "../../protocol/app-service-types.js"
import { readChildStop } from "../session/chat-session-run-evidence.js"
import { recordChildWorkflowStartFailure, recordChildWorkflowStop } from "../session/child-workflow-result.js"
import { observeSessionChanged } from "../session/reply-waits.js"
import type { WorkflowControllerDeps } from "./controller.js"
import type { WorkflowCompletionAcknowledgement, WorkflowResult } from "./runner-types.js"
import { workflowRunReader } from "../module-catalog.js"

const log = Log.create({ service: "workflow-controller" })

interface WorkflowOrigin {
  workflowName: string
  resolve: (result: BackgroundWorkResult) => void
  tracking: WorkflowRunTracking
}

interface WorkflowRunTracking {
  readonly done: Promise<BackgroundWorkResult>
  readonly terminate: (source: BackgroundKillSource) => Promise<void>
  readonly interruption: ChildInterruption
}

export interface WorkflowLaunchLifecycle {
  restoreLaunchTracking(id: string, tasks: BackgroundWorkTracking): Promise<void>
  /** Registers a run with its original parent. A `new` run, a launch or a
   *  Resume that starts a runner, gets its own tracking and replaces the
   *  parent's observer of an earlier run, so a late notice of that run
   *  retires only that run. A `continued` run keeps the tracking it has. */
  track(id: string, workflowName: string, run: "new" | "continued"): Promise<WorkflowRunTracking>
  /** Whether a person or the parent agent interrupted the launched child
   *  now, read from its runner, for the parent's background work. */
  interruption(id: string): ChildInterruption
  /** The runner's report that who made its interrupt changed. */
  notifyInterruption(id: string): void
  stopLaunch(id: string, stoppedBy: StoppedBy): Promise<void>
  notifyOriginCoreCompleted(id: string, result: WorkflowResult): Promise<WorkflowCompletionAcknowledgement>
  handleRunnerDone(id: string, result: WorkflowResult): Promise<void>
  handleRunnerError(id: string, err: unknown): Promise<void>
  handleStartFailure(id: string, err: unknown): Promise<void>
}

/** Owns live launch promises while durable reconciliation remains the settlement authority. */
export function createWorkflowLaunchLifecycle(deps: WorkflowControllerDeps): WorkflowLaunchLifecycle {
  const { workflowHosts, projectionReader } = deps
  const runs = workflowRunReader(projectionReader)
  const origins = new Map<string, WorkflowOrigin>()
  // The parent's background work that observes each launched child's
  // interrupt. The interrupt itself lives only in the child's runner, the
  // one that a later run of the child also reports from.
  const interruptionListeners = new Map<string, Set<() => void>>()

  async function track(id: string, workflowName: string, run: "new" | "continued"): Promise<WorkflowRunTracking> {
    const binding = (await runs.read(id))?.launchedFrom
    const host = binding?.toolUseId
      ? await parentHost(deps, binding.parentSessionId, binding.conversationId)
      : undefined
    if (binding?.toolUseId && deps.openChatRunner && !host?.backgroundTasks) throw new Error(`Resume parent '${binding.parentSessionId}' first: the child's parent host is not running.`)
    const tasks = host?.backgroundTasks
    const existing = origins.get(id)
    let tracked = existing?.tracking
    if (!tracked || run === "new") {
      // The earlier run ended without its parent's acknowledgement, so
      // nothing settles its tracking: the parent stops observing it here.
      if (existing) tasks?.detach(id)
      const completion = Promise.withResolvers<BackgroundWorkResult>()
      const terminate = (source: BackgroundKillSource) => stopLaunch(id, source === "agent" ? "agent" : "person")
      tracked = { done: completion.promise, terminate, interruption: interruption(id) }
      origins.set(id, { workflowName, resolve: completion.resolve, tracking: tracked })
    }
    if (binding?.toolUseId && tasks) await observe(id, workflowName, tracked, { parentSessionId: binding.parentSessionId, toolUseId: binding.toolUseId }, tasks)
    return tracked
  }

  async function restoreLaunchTracking(id: string, tasks: BackgroundWorkTracking): Promise<void> {
    const origin = origins.get(id)
    if (!origin) return
    const binding = (await runs.read(id))?.launchedFrom
    if (binding?.toolUseId) await observe(id, origin.workflowName, origin.tracking, { parentSessionId: binding.parentSessionId, toolUseId: binding.toolUseId }, tasks)
  }

  async function observe(id: string, workflowName: string, tracked: WorkflowRunTracking, binding: { parentSessionId: string; toolUseId: string }, tasks: BackgroundWorkTracking): Promise<void> {
    const tool = await readToolExecution(projectionReader, binding.parentSessionId, binding.toolUseId)
    // Completion can settle the run while its parent's call is read.
    if (origins.get(id)?.tracking !== tracked) return
    const record = tasks.processRecord(id)
    if (record?.status === "running" || record?.status === "stopping") return
    const source = workflowCallSource(tool?.input)
    const label = source && source.kind !== "registered" ? workflowSourceLabel(source) : workflowName
    const description = tool?.input ? textField(tool.input, "summary") ?? textField(tool.input, "task_summary") ?? label : label
    tasks.track({
      done: tracked.done,
      kill: { run: tracked.terminate },
      interruption: tracked.interruption,
      hostClose: "detach",
      meta: {
        id, type: "workflow", description, toolUseId: binding.toolUseId, settlementOwner: "child_session",
      },
    })
  }

  function interruption(id: string): ChildInterruption {
    return {
      interruptedBy() {
        return workflowHosts.get(id)?.interruption()
      },
      observe(listener) {
        const listeners = interruptionListeners.get(id) ?? new Set<() => void>()
        interruptionListeners.set(id, listeners)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) interruptionListeners.delete(id)
        }
      },
    }
  }

  function notifyInterruption(id: string): void {
    const listeners = interruptionListeners.get(id)
    if (!listeners) return
    log.info("workflow interruption reported to its parent", { sessionId: id })
    for (const listener of listeners) listener()
  }

  /** The parent's call that launched a bound child, or nothing for an
   *  unbound one. */
  async function launchCall(id: string): Promise<{ readonly parentSessionId: string; readonly toolUseId: string } | undefined> {
    const session = await runs.read(id)
    if (!session?.launchedFrom?.toolUseId) return undefined
    return { parentSessionId: session.launchedFrom.parentSessionId, toolUseId: session.launchedFrom.toolUseId }
  }

  /** Answers a model's waiting call, if one still waits, from the Stop its
   *  parent's call records. */
  async function answerStop(id: string, stoppedBy: StoppedBy): Promise<void> {
    if (!origins.has(id)) return
    const handoff = await readTerminalHandoff(projectionReader, id)
    // Another end can answer the call during the read.
    const origin = origins.get(id)
    if (!origin) return
    origins.delete(id)
    origin.resolve({ status: stoppedBy === "person" ? "stopped" : "cancelled", content: workflowStopContent({ label: origin.workflowName, sessionId: id, stoppedBy, handoff }) })
  }

  /** How the end of a child's run stands for its parent's call, as the
   *  child's runner reports that end. The parent's reconciliation proves
   *  the end durable, and the runner waits for it. A call that holds a Stop
   *  is settled already, and the Stop asked the parent to reconcile, so the
   *  runner of a stopped child does not wait: that reconciliation runs
   *  behind the parent's running turn, and that turn can wait for the
   *  teardown the Stop started. An unbound child has no call, so its end
   *  stands at once. */
  async function reportEnd(id: string): Promise<{ readonly durable: boolean; readonly stoppedBy?: StoppedBy }> {
    const call = await launchCall(id)
    if (!call) return { durable: true }
    const stoppedBy = await readChildStop(projectionReader, call)
    if (stoppedBy) return { durable: true, stoppedBy }
    const reconciliation = await deps.reconcileChildSessionCompletions?.(call.parentSessionId)
    if (!reconciliation?.durableTerminalChildSessionIds?.includes(id)) return { durable: false }
    // A Stop that lands while the parent reconciles is the call's result.
    const lateStop = origins.has(id) ? await readChildStop(projectionReader, call) : undefined
    return lateStop ? { durable: true, stoppedBy: lateStop } : { durable: true }
  }

  async function notifyOriginCoreCompleted(id: string, result: WorkflowResult): Promise<WorkflowCompletionAcknowledgement> {
    const end = await reportEnd(id)
    if (!end.durable) return end
    if (end.stoppedBy) {
      await answerStop(id, end.stoppedBy)
      return end
    }
    if (!origins.has(id)) return end
    const evidence = await readWorkflowCompletionEvidence(projectionReader, id)
    // A Stop can answer the call during the read.
    const origin = origins.get(id)
    if (!origin) return end
    origins.delete(id)
    origin.resolve({
      status: result.completed ? "completed" : "failed",
      content: workflowCompletionContent({
        status: result.completed ? "completed" : "failed",
        label: origin.workflowName,
        sessionId: id,
        ...(result.reason ? { reason: result.reason } : {}),
        ...evidence,
      }),
      usage: { totalTokens: result.tokens, toolUses: result.attemptsCompleted, durationMs: 0 },
    })
    return end
  }

  /** The one Stop of a launched workflow (`WorkflowLaunchHost.stopLaunch`).
   *  The Stop is the first result of the parent's launching call, so the
   *  child's row, its resume, and the parent's transcript all read it from
   *  one fact. The fact lands before the teardown, because the teardown
   *  takes the child idle and every client re-reads the child's admitted
   *  actions on that edge. A live tracked run corrects an earlier result
   *  through the workflow correction fact, leaving the earlier fact intact.
   *  A call without a live run keeps its earlier result.
   *
   *  The Stop is complete once the fact is durable. It answers a model's
   *  waiting call from the fact at once, then asks the parent to reconcile
   *  and the session store to tear the child down, and it waits for
   *  neither. The parent's reconciliation delivers the notification the
   *  parent reads, behind the parent's running turn, and that turn can wait
   *  on the answer. The teardown reports the child's end from the fact, so
   *  it does not wait for the parent (`reportEnd`). A runner that began to
   *  report an earlier end before the Stop landed still waits for that
   *  report, and its teardown ends when that report does. A child whose
   *  runtime still starts has no runner to abort: its run pauses before its
   *  first attempt, where the workflow host reads the Stop. The session
   *  store owns the teardown, and its disposal awaits it. A failure of
   *  either is logged, and the parent's next activation reconciles again. */
  async function stopLaunch(id: string, stoppedBy: StoppedBy): Promise<void> {
    const child = await runs.read(id)
    const binding = child?.launchedFrom
    if (!child || !binding?.toolUseId) {
      log.info("workflow stop decision", { sessionId: id, stoppedBy, decision: "unbound" })
      return
    }
    const { parentSessionId } = binding
    const stopped = await recordChildWorkflowStop({ reader: deps.eventReader, projectionReader, writer: deps.eventWriter, parentSessionId, toolUseId: binding.toolUseId, childSessionId: id, workflowDefinitionId: child.workflowDefinitionId, stoppedBy, correctPriorResult: origins.has(id) })
    log.info("workflow stop decision", { sessionId: id, parentSessionId, stoppedBy, decision: stopped ? "stopped" : "already-settled" })
    if (!stopped) return
    await answerStop(id, stoppedBy)
    // An interrupted child has no live run to report its end, so each wait
    // on it learns of the Stop here (PI-INTERACTION-136).
    void observeSessionChanged(projectionReader, id).catch((error: unknown) => {
      log.warn("workflow stop could not end the waits on the child", { sessionId: id, error: errorMessage(error) })
    })
    void deps.reconcileChildSessionCompletions?.(parentSessionId).catch((error: unknown) => {
      log.warn("workflow stop reconciliation failed", { sessionId: id, parentSessionId, error: errorMessage(error) })
    })
    void workflowHosts.abort(id, stoppedBy).catch((error: unknown) => {
      log.warn("workflow stop teardown failed", { sessionId: id, parentSessionId, error: errorMessage(error) })
    })
  }

  async function handleRunnerDone(id: string, result: WorkflowResult): Promise<void> {
    if (origins.has(id)) await notifyOriginCoreCompleted(id, result)
    deps.onRunnerDone?.(id, "inactive", result)
  }

  /** A published child whose runtime could not start (ARCH-SESSIONS-021). Its parent's
   *  call records the failure as its result, never as a Stop, and the child
   *  then fails through the runner-error path: it stays published, paused,
   *  and resumable, and its launch settles failed through reconciliation. */
  async function handleStartFailure(id: string, err: unknown): Promise<void> {
    const child = await runs.read(id)
    if (child?.launchedFrom?.toolUseId) {
      await recordChildWorkflowStartFailure({
        reader: deps.eventReader,
        projectionReader,
        writer: deps.eventWriter,
        parentSessionId: child.launchedFrom.parentSessionId,
        toolUseId: child.launchedFrom.toolUseId,
        childSessionId: id,
        workflowDefinitionId: child.workflowDefinitionId,
      })
    }
    await handleRunnerError(id, err)
  }

  async function handleRunnerError(id: string, err: unknown): Promise<void> {
    const message = errorMessage(err)
    const end = await reportEnd(id)
    if (end.stoppedBy) await answerStop(id, end.stoppedBy)
    const origin = end.durable ? origins.get(id) : undefined
    if (origin) origins.delete(id)
    try {
      await deps.onRunnerError?.(id, message)
    } finally {
      origin?.resolve({ status: "failed", content: `Workflow "${origin.workflowName}" failed: ${message}` })
    }
  }

  return {
    restoreLaunchTracking,
    track,
    interruption,
    notifyInterruption,
    stopLaunch,
    notifyOriginCoreCompleted,
    handleRunnerDone,
    handleRunnerError,
    handleStartFailure,
  }
}
