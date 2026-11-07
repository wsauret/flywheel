import { failureTerminal, type AgentRunTerminal } from "../agent-runtime/types.js"
import { blockedFailureRecord, describeAgentFailure } from "../agent-runtime/failure-message.js"
import { createEmit, EventBus } from "../../infra/event-bus.js"
import type { ProviderRequestAuditFact } from "../session/provider-request-audit-facts.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js"
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js"
import { createKeyResolver, createOwnedCredentialCommandRunner } from "../../infra/auth/resolve-key.js"
import { resolveConversationSearchDbFile, resolveSessionDir } from "../../infra/paths.js"
import { acquireConversationSearchIndex } from "../../infra/conversation-fts.js"
import { AuthProfileManager } from "../auth/auth-profile-manager.js"
import { prepareWorkflowDeps } from "../workflow-host/deps.js"
import { createSessionFactWriter, type SessionFactWriter } from "../session/session-fact-writer.js"
import { reconcileWorkspacePendingFileMutations } from "../session/file-mutation-recovery.js"
import { createConversationTreeWriterController } from "../chat/tree-writer.js"
import { createConversationRecall } from "../session/conversation-recall.js"
import { ChatTurnMailbox } from "../chat/turn-mailbox.js"
import { createRunnerBusBridge } from "../runner/bus-bridge.js"
import { getSharedModelsClient } from "../config/llm-clients.js"
import type { ModelsClient } from "../../infra/llm/models.js"
import { createBackgroundExecutionOwner } from "../agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../agent-runtime/background-work.js"
import { emitToolExecutionOutput } from "../agent-runtime/emit.js"
import { createForegroundBashHoldController } from "../agent-runtime/foreground-bash-hold.js"
import { capabilityAccessFor } from "../agent-runtime/tools/types.js"
import { subscribeSessionRuntimeFacts } from "../session/create-session-infra.js"
import { createTaskProgressWriter, HEADLESS_PROGRESS_EVENT_TYPES } from "./task-progress.js"
import { createAgentHost } from "../runner/host.js"
import { AgentTurnAborted } from "../runner/agent-turn-types.js"
import { createUnattendedRecovery } from "../agent-runtime/unattended-recovery.js"
import { HEADLESS_MODULE_CEILING } from "./host-registration.js"
import { runHeadlessBootstrap } from "./headless-bootstrap.js"
import { createHeadlessDeadline, type HeadlessDeadlineExpired } from "./headless-deadline.js"
import { createHeadlessUsageAuthorityOwner, type HeadlessUsageAuthorityOwner } from "./headless-usage-authority.js"

import { captureRuntimeConfigRequest } from "../agent-runtime/request-config.js"
import { createHeadlessProfileRuntime, resolveHeadlessAuth } from "./headless-profile-runtime.js"
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { personaRoleIds } from "../../workflows/definition-registry.js"
export interface RunHeadlessTaskOptions {
  directories: StartupDirectories
  launcher: LauncherScope
  authProfile?: string
  authSnapshot?: string
  sourceArchiveSha256?: string
  disabledTools?: readonly string[]
  systemPrompt?: string
  /** Authored chat model for this run. An unreachable setting follows the role defaults. */
  model?: string
  /** Authored chat effort for this run, also supported without a model override. */
  effort?: string
  deadlineSeconds?: number
  printErrorsToStderr?: boolean
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient
  allowPersistentProcesses?: boolean
  prepareWorkflowDeps?: typeof prepareWorkflowDeps
  /** Catalog metadata the run reads and refreshes; the account root's shared client by default. */
  modelsClient?: ModelsClient
  connectEventBus?: (bus: EventBus) => void
}

interface HeadlessTaskUsage {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  costUsd: number
}

interface HeadlessTaskTermination {
  readonly version: 2
  readonly terminal?: AgentRunTerminal
  readonly deadlineFired: boolean
}

export interface HeadlessTaskResult {
  completed: boolean
  projectRoot: string
  sessionId?: string
  /** Final assistant reply, also printed to stdout by the CLI. */
  finalMessage?: string
  usage?: HeadlessTaskUsage
  report?: HeadlessTaskReport
  termination: HeadlessTaskTermination
  error?: string
}

interface HeadlessTaskReport {
  model?: string
  effort?: string
  sourceArchiveSha256?: string
  toolSurfaces: readonly HeadlessToolSurface[]
}

interface HeadlessToolSurface {
  readonly toolSurfaceHash: string
  readonly tools: readonly string[]
}

const log = Log.create({ service: "headless-task" })
const SOURCE_ARCHIVE_SHA256_PATTERN = /^[a-f0-9]{64}$/

/** Drains all bus subscribers before the session writer refuses new work. */
export async function disposeHeadlessRuntimeEvents(bus: EventBus, sessionEventWriter: Pick<SessionFactWriter, "dispose">): Promise<void> {
  try {
    await bus.dispose()
  } finally {
    sessionEventWriter.dispose()
  }
}

/** Attempts every ordered headless cleanup stage before reporting their combined failure. */
export async function disposeHeadlessTaskResources(options: {
  closeBackground(): Promise<void>
  awaitForegroundBash(): Promise<void>
  disposeForegroundBash(): void
  awaitTurnFlush(): Promise<void>
  disposeTree(): Promise<void>
  disposeRecallIndex(): Promise<void>
  disposeRuntimeEvents(): Promise<void>
  updateLifecycle(): Promise<void>
  getPersistenceFailure(): Error | null
}): Promise<void> {
  const failures: Error[] = []
  const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (cause) {
      failures.push(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }

  await attempt(options.closeBackground)
  await attempt(options.awaitForegroundBash)
  await attempt(options.disposeForegroundBash)
  await attempt(options.awaitTurnFlush)
  await attempt(options.disposeTree)
  await attempt(options.disposeRecallIndex)
  await attempt(options.disposeRuntimeEvents)
  await attempt(() => {
    const persistenceFailure = options.getPersistenceFailure()
    if (persistenceFailure) throw persistenceFailure
  })
  if (failures.length === 0) await attempt(options.updateLifecycle)
  if (failures.length > 0) {
    throw new AggregateError(failures, `Headless task cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`)
  }
}

/** Runs one immutable direct task through the shared ordinary runner host. */
export async function runHeadlessTask(task: string, options: RunHeadlessTaskOptions): Promise<HeadlessTaskResult> {
  const deadline = createHeadlessDeadline(options.deadlineSeconds)
  let terminal: AgentRunTerminal | undefined
  const sourceArchiveSha256 = validateSourceArchiveSha256(options.sourceArchiveSha256)
  const { directories } = options
  const resolveKey = createKeyResolver(createOwnedCredentialCommandRunner(options.launcher))
  const { projectRoot, executionCwd, userDataRoot, accountHome } = directories
  let sessionId: string | undefined
  let finalMessage: string | undefined
  let usage: HeadlessTaskUsage | undefined
  let model: string | undefined
  let effort: string | undefined
  let toolSurfaces: readonly HeadlessToolSurface[] = []
  let completed = false
  let failure: unknown
  let usageAuthority: HeadlessUsageAuthorityOwner | undefined

  try {
    let authProfile: Awaited<ReturnType<AuthProfileManager["resolve"]>>
    await runHeadlessBootstrap({
      directories,
      launcher: options.launcher,
      disabledTools: options.disabledTools,
      awaitModulePolicy: deadline.awaitSetup,
    }, async ({ capabilityPolicy, moduleSelection, definitions, runtimeConfig, eventState, eventWriter, writerLane, startModuleServices, createManager, captureSubscriptionAdmission }) => {
      // Servers connect while the run resolves its profile and definitions.
      const moduleServicesStart = startModuleServices()
      const oneShotConfig = runtimeConfig.snapshot().config
      const definitionRevision = definitions.captureRevision()
      const effectivePersonaRoleIds = personaRoleIds(definitionRevision.personas)
      const authProfiles = new AuthProfileManager({
        userDataRoot,
        projectRoot,
        config: () => oneShotConfig,
        ...(options.authProfile ? { env: { FLYWHEEL_AUTH_PROFILE: options.authProfile } } : {}),
      })
      const resolved = await deadline.awaitSetup(resolveHeadlessAuth(authProfiles, options.authSnapshot, accessProviderRegistry(moduleSelection()).selection.definitions))
      authProfile = resolved.profile
      const snapshot = resolved.snapshot
      const capturedProfileId = snapshot?.profileId ?? authProfile.id
      const requestConfig = captureRuntimeConfigRequest(runtimeConfig.snapshot(), capturedProfileId, options.allowPersistentProcesses)
      usageAuthority = createHeadlessUsageAuthorityOwner({ id: capturedProfileId, directory: authProfile.directory })
      const captureRuntimeConfig = () => requestConfig
      const { services: moduleServices, notices } = await deadline.awaitSetup(moduleServicesStart)
      for (const notice of notices) process.stderr.write(`${notice}\n`)
      const profileRuntime = await createHeadlessProfileRuntime({
        userDataRoot,
        modelsClient: options.modelsClient ?? getSharedModelsClient(userDataRoot),
        profile: { id: capturedProfileId, directory: authProfile.directory },
        moduleSelection,
        allowTrainingRoutes: requestConfig.allowTrainingRoutes,
        resolveKey,
        ...(snapshot ? { connection: snapshot.connection } : {}),
        workflowPreparation: {
          ...directories,
          definitions,
          moduleSelection,
          moduleServices,
          launcher: options.launcher,
          resolveKey,
          persistentProcesses: options.persistentProcesses,
          allowPersistentProcesses: () => requestConfig.allowPersistentProcesses,
          capabilities: capabilityPolicy.policy,
          headless: true,
          ...(snapshot ? { overrides: { connection: snapshot.connection } } : {}),
        },
        captureRuntimeConfig,
        captureSubscriptionAdmission: (candidates, providerSettings) => captureSubscriptionAdmission({ id: capturedProfileId, directory: authProfile.directory }, candidates, providerSettings),
        acquireUsageSettlementAuthority: usageAuthority.acquire,
        prepareWorkflowDeps: options.prepareWorkflowDeps ?? prepareWorkflowDeps,
      })
      const wfDeps = await deadline.awaitSetup(profileRuntime.prepare())
      const workspaceRecovery = await reconcileWorkspacePendingFileMutations({ projectRoot, store: eventState, writer: eventWriter })
      for (const recovered of workspaceRecovery) {
        for (const recoveryFailure of recovered.failures) {
          log.error("headless file mutation recovery deferred", {
            sessionId: recovered.sessionId,
            mutationId: recoveryFailure.mutationId,
            path: recoveryFailure.path,
            error: recoveryFailure.message,
          })
        }
      }
      const manager = createManager(oneShotConfig)
        const initialRoles: import("../session/schemas.js").RoleSettings = options.model !== undefined || options.effort !== undefined
          ? { chat: { ...(options.model === undefined ? {} : { model: options.model }), ...(options.effort === undefined ? {} : { effort: options.effort }) } }
          : {}
        const activeSessionId = await manager.createChat({ name: "headless task", initialRoles, authProfileId: capturedProfileId })
        sessionId = activeSessionId
        const session = await manager.read(activeSessionId)
        if (!session || session.kind !== "chat") throw new Error(`headless task session ${activeSessionId} missing after creation`)
        if (!session.roleAssignments) throw new Error(`headless task session ${activeSessionId} has no role snapshot`)
        const { createSessionRoleResolver } = await import("../config/session-role-resolver.js")
        const resolveSessionRoles = createSessionRoleResolver({ reader: eventState, projectRoot, sessionId: activeSessionId, userDataRoot, capture: wfDeps.captureProviderConnection, requiredRoleIds: effectivePersonaRoleIds })
        const conversationId = session.conversationId
        const sessionEventWriter = createSessionFactWriter({
          sessionId: activeSessionId,
          writer: eventWriter,
          lane: writerLane.lease({ kind: "session", sessionId: activeSessionId }),
        })
        const recallIndex = acquireConversationSearchIndex(resolveConversationSearchDbFile(projectRoot), eventState)
        const localRecall = (id: string) => createConversationRecall({
          store: eventState,
          index: recallIndex,
          conversationId: id,
        })
        const treeWriter = createConversationTreeWriterController({
          conversationId, sessionId: activeSessionId, projectRoot, store: eventState, projectionReader: eventState, writer: eventWriter,
          recall: localRecall(conversationId),
        })
        const bus = new EventBus()
        options.connectEventBus?.(bus)
        const emit = createEmit(bus)
        const progress = createTaskProgressWriter((line) => process.stderr.write(`${line}\n`))
        bus.subscribeToTypes(HEADLESS_PROGRESS_EVENT_TYPES, progress.event, {
          delivery: "direct",
          deliveryClass: "diagnostic",
          label: "headless-task-progress",
        })
        const runtimeFacts = subscribeSessionRuntimeFacts(bus, { sessionEventWriter, requireStoredFacts: true })
        const runTally = createHeadlessRunTally()
        const runnerBusBridge = createRunnerBusBridge({ emit, sessionId: activeSessionId })

        const tail: Promise<void> = Promise.resolve()
        const inputMailbox = new ChatTurnMailbox()
        const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
          kind: "chat",
          enqueueNotification: (text, key) => inputMailbox.enqueueBackgroundNotification({ text, ...(key ? { key } : {}) }),
          onExecutionOutput: (toolUseId, output, identity) => {
            emitToolExecutionOutput((event) => { emit(event.type, { sessionId: activeSessionId, data: event.data }) }, toolUseId, output, identity)
          },
        }))
        const foregroundBashHold = createForegroundBashHoldController(() => {})

        try {
          await treeWriter.commitSystemTurn(task)

          const runnerHost = createAgentHost({ createRunner: wfDeps.createAgent })
          // A capacity wait lives and ends with this process, within the
          // task's own deadline, so it records no durable authority (PI-MODEL-063).
          const recovery = createUnattendedRecovery({
            sessionId: activeSessionId,
            runId: conversationId,
            caller: "headless",
            agentName: "headless task",
            onNotice: progress.notice,
            awaitAccessSettled: wfDeps.awaitModelAccessSettled,
          })
          const running = runnerHost.runTurn({
            createContextOptions: async ({ providerSessionKey }) => {
              // A deadline that fired in setup that nothing races ends the turn
              // the way a deadline that interrupts it does: aborted.
              if (deadline.expired) throw new AgentTurnAborted()
              // Each attempt reads the tree, so a recovered attempt continues
              // with the tool calls and results that the failed one flushed.
              const priorContext = await treeWriter.buildContext()
              treeWriter.beginTurn()
              const persistedRoles = await deadline.awaitSetup(resolveSessionRoles())
              const persistedChat = persistedRoles.get("chat")
              model = persistedChat?.model
              effort = persistedChat?.effort
              return {
                model,
                effort,
                providerOptions: persistedChat?.providerOptions,
                requestSelection: (currentRoles) => {
                  const current = currentRoles.get("chat")
                  model = current?.model
                  effort = current?.effort
                  return { roleId: "chat", ...current }
                },
                availableModels: wfDeps.availableModels,
                resolveRoles: resolveSessionRoles,
                agentRegistry: definitionRevision.personas,
                auth: wfDeps.auth,
                executionCwd,
                projectRoot,
                userDataRoot,
                accountHome,
                sessionDir: resolveSessionDir(activeSessionId, projectRoot),
                task: "",
                purpose: {
                  kind: "headless-task",
                  prompt: options.systemPrompt === undefined
                    ? { kind: "assembled", corePrompt: "You are a helpful AI Agent." }
                    : { kind: "literal", systemPrompt: options.systemPrompt },
                },
                // Direct tasks are automation and benchmark invocations, not
                // code authorship or review, so their prompts omit doctrine.
                engineeringDoctrine: false,
                waitForEventCapacity: (signal) => bus.waitForCapacity(signal),
                capabilityAccess: capabilityAccessFor(capabilityPolicy.policy, undefined, HEADLESS_MODULE_CEILING),
                conversation: {
                  kind: "durable-tree",
                  sessionId: activeSessionId,
                  conversationId,
                  providerSessionKey: providerSessionKey ?? conversationId,
                  priorMessages: priorContext.messages,
                  resolveLeafId: () => treeWriter.getLeafId(),
                  committedTree: () => treeWriter.getState(),
                  captureCommittedForkMessages: () => treeWriter.captureCommittedForkMessages(),
                  reserveMessageId: treeWriter.reserveMessageId,
                  releaseMessageId: treeWriter.releaseMessageId,
                  append: (message, entryId) => {
                    if (message.kind === "assistant") {
                      finalMessage = typeof message.content === "string"
                        ? message.content
                        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
                    }
                    return treeWriter.recordCanonicalMessage(message, entryId)
                  },
                  recordCompaction: (compactionInput) => treeWriter.recordCompaction(compactionInput).then((result) => result?.messages),
                  flush: treeWriter.flushSavePoint,
                  awaitDurableFacts: runtimeFacts.awaitDurableFacts,
                },
                runtimeSurfaces: { background, foregroundBashHold, recall: treeWriter.recall },
                createChildConversation: (childRunId) => createConversationTreeWriterController({
                  conversationId: childRunId,
                  sessionId: activeSessionId,
                  projectRoot,
                  store: eventState,
                  projectionReader: eventState,
                  writer: eventWriter,
                  recall: localRecall(childRunId),
                }),
                ...runnerBusBridge,
                lifecycle: {
                  kind: "complete-on-idle",
                  ...runnerBusBridge.lifecycle,
                  inputSource: inputMailbox,
                  onTurnEnded: () => undefined,
                },
                sessionEventWriter,
                auditObserver: (fact) => {
                  runTally.observe(fact)
                  progress.audit(fact)
                },
                usageObserver: (entry) => {
                  if (entry.coverage === "unmeasured") return
                  runTally.observeCommittedUsage({
                    usageEntryId: entry.attemptId,
                    costUsdDelta: entry.price.kind === "priced" ? entry.price.estimatedUsd : null,
                    tokens: entry.tokens,
                  })
                  progress.usage(entry)
                },
                sessionEventStore: eventState,
                sessionEventReader: eventState,
              }
            },
            message: task,
            resilience: {
              originalProviderSessionKey: conversationId,
              recover: recovery.recover,
              settle: recovery.settle,
            },
          })
          const result = await deadline.awaitActive(running, async () => {
            runnerHost.abortGeneration()
            await runnerHost.settle()
          })
          terminal = result.terminal
          await bus.drain()
          completed = result.terminal.kind === "completed"
          if (!completed) reportError(`Headless task did not complete: ${incompleteCause(result.terminal, deadline.expiry)}`, options)
        } finally {
          try {
            await disposeHeadlessTaskResources({
              closeBackground: () => background.close(),
              awaitForegroundBash: () => foregroundBashHold.awaitSettlement(),
              disposeForegroundBash: () => foregroundBashHold.dispose(),
              awaitTurnFlush: () => tail,
              disposeTree: () => treeWriter.dispose(),
              disposeRecallIndex: () => recallIndex.dispose(),
              disposeRuntimeEvents: () => disposeHeadlessRuntimeEvents(bus, sessionEventWriter),
              updateLifecycle: () => manager.updateLifecycleState(activeSessionId, "inactive"),
              getPersistenceFailure: runtimeFacts.getPersistenceFailure,
            })
          } finally {
            toolSurfaces = runTally.toolSurfaces()
            usage = runTally.usage()
          }
        }
      return { result: undefined, settle: async () => {
        await profileRuntime.dispose()
        await usageAuthority?.settled()
      } }
    })
  } catch (err) {
    completed = false
    failure = err
  }
  try {
    await usageAuthority?.settled()
  } catch (cause) {
    completed = false
    failure = failure === undefined ? cause : new AggregateError([failure, cause], "Headless task and Usage authority settlement failed")
  }
  deadline.dispose()

  const attribution = headlessTaskReport(sourceArchiveSha256, toolSurfaces, model, effort)
  const termination: HeadlessTaskTermination = {
    version: 2,
    ...(terminal ? { terminal } : {}),
    deadlineFired: deadline.expired,
  }
  if (failure !== undefined) {
    const message = errorMessage(failure)
    reportError(`Headless task error: ${message}`, options)
    return {
      completed: false,
      projectRoot,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      report: attribution,
      termination,
      error: message,
    }
  }
  return {
    completed,
    projectRoot,
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
    ...(finalMessage !== undefined ? { finalMessage } : {}),
    report: attribution,
    termination,
  }
}

/** Token counts of one measured attempt. A null count is a detail the provider did not report, which adds nothing. */
interface ReportedTokens { readonly input: number | null; readonly output: number | null; readonly cacheRead: number | null; readonly reasoning: number | null }

export interface HeadlessRunTally {
  /** Wired as the run's `auditObserver`; sees every provider-request audit
   *  record the run and its subagents emit, in emission order. */
  observe(fact: ProviderRequestAuditFact): void
  observeCommittedUsage(entry: {
    readonly usageEntryId: string
    readonly costUsdDelta: number | null
    readonly tokens: ReportedTokens
  }): void
  usage(): HeadlessTaskUsage
  toolSurfaces(): readonly HeadlessToolSurface[]
}

/** Accumulates historical audit usage and current committed usage exactly once per attempt. The benchmark fixture reads these numbers from the CLI summary line.
 *  `requests` counts every dispatched provider request, as the store's
 *  dispatch facts do, so a request that a deadline or an abort cut before it
 *  measured usage still counts. */
export function createHeadlessRunTally(): HeadlessRunTally {
  const usage: HeadlessTaskUsage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd: 0 }
  const dispatchedRequests = new Set<string>()
  const seenTokenEntries = new Set<string>()
  const seenCostEntries = new Set<string>()
  const seenSurfaces = new Set<string>()
  const surfaces: HeadlessToolSurface[] = []
  const observeTokens = (id: string, tokens: ReportedTokens): void => {
    if (seenTokenEntries.has(id)) return
    seenTokenEntries.add(id)
    usage.inputTokens += tokens.input ?? 0
    usage.outputTokens += tokens.output ?? 0
    usage.cacheReadTokens += tokens.cacheRead ?? 0
    usage.reasoningTokens += tokens.reasoning ?? 0
  }
  const observeCost = (id: string, costUsdDelta: number | null): void => {
    if (costUsdDelta === null || seenCostEntries.has(id)) return
    seenCostEntries.add(id)
    usage.costUsd += costUsdDelta
  }
  return {
    observe(fact) {
      if (fact.type === "model.request.dispatched") {
        dispatchedRequests.add(fact.payload.requestId)
        usage.requests = dispatchedRequests.size
        return
      }
      if (fact.type === "model.usage.recorded") {
        const id = "attemptId" in fact.payload ? fact.payload.attemptId : fact.payload.requestId
        observeTokens(id, {
          input: fact.payload.inputTokens,
          output: fact.payload.outputTokens,
          cacheRead: fact.payload.cacheReadInputTokens,
          reasoning: fact.payload.reasoningTokens,
        })
        if ("deltaCostUsd" in fact.payload) observeCost(id, fact.payload.deltaCostUsd)
        return
      }
      if (fact.type !== "tool_surface.selected" || seenSurfaces.has(fact.payload.toolSurfaceHash)) return
      seenSurfaces.add(fact.payload.toolSurfaceHash)
      surfaces.push(Object.freeze({
        toolSurfaceHash: fact.payload.toolSurfaceHash,
        tools: Object.freeze(fact.payload.tools.map((tool) => tool.name).sort()),
      }))
    },
    observeCommittedUsage(entry) {
      observeTokens(entry.usageEntryId, entry.tokens)
      observeCost(entry.usageEntryId, entry.costUsdDelta)
    },
    usage() {
      return { ...usage, costUsd: Number(usage.costUsd.toFixed(6)) }
    },
    toolSurfaces() {
      return Object.freeze([...surfaces])
    },
  }
}



function validateSourceArchiveSha256(value: string | undefined): string | undefined {
  if (value !== undefined && !SOURCE_ARCHIVE_SHA256_PATTERN.test(value)) {
    throw new Error("Source archive SHA-256 must be exactly 64 lowercase hexadecimal characters")
  }
  return value
}

function headlessTaskReport(
  sourceArchiveSha256: string | undefined,
  toolSurfaces: readonly HeadlessToolSurface[],
  model: string | undefined,
  effort: string | undefined,
): HeadlessTaskReport {
  return {
    ...(sourceArchiveSha256 ? { sourceArchiveSha256 } : {}),
    toolSurfaces,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** Names why a run ended without completing. A deadline that interrupted the
 *  run is the cause, not the `aborted` terminal it produced. A failure prints
 *  the line a chat transcript records for it, so stderr names the same remedy;
 *  the JSON summary keeps the raw terminal for machines. */
function incompleteCause(terminal: AgentRunTerminal, expiry: HeadlessDeadlineExpired | undefined): string {
  if (expiry !== undefined) return expiry.message
  const failure = failureTerminal(terminal)
  return failure === null ? terminal.kind : blockedFailureRecord(describeAgentFailure(failure))
}

function reportError(message: string, options: Pick<RunHeadlessTaskOptions, "printErrorsToStderr">): void {
  log.error(message)
  if (options.printErrorsToStderr !== false) process.stderr.write(`${message}\n`)
}
