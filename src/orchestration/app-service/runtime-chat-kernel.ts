import { ManagedRuntime } from "effect"
import { EventReaderService, EventStoreLive, EventStoreService, EventStoreWriterLaneService, EventStoreWriterService, type EventStoreRuntime, type RuntimeEventState } from "../../infra/event-store-effect.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { loggedOperation } from "../../infra/operation-log.js"
import { Log } from "../../infra/log.js"
import { prepareWorkspaceState } from "../workspace-state.js"
import { createSessionManager, type SessionManager } from "../session/manager.js"
import { createSessionStore } from "../session-store/store.js"
import type { SessionStore } from "../session-store/types.js"
import { workflowRunOwner } from "../module-catalog.js"
import type { WorkflowHosts } from "../workflow-host/host-collection.js"
import { childSessionProjectionAttachment } from "../session-store/child-session-projection.js"
import type { RuntimeOwnership } from "./runtime-ownership.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createRuntimeUiBus, type RuntimeUiBus } from "./runtime-ui-bus.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import { createTranscriptProjectionCache, type TranscriptProjectionCache } from "./transcript-projection-cache.js"
import { createFrontendProjections } from "./frontend-projections.js"
import type { RuntimeBackgroundLane } from "./runtime-background-lane.js"
import { createCommandKeeper, type CommandKeeper } from "./command-keeper.js"
import { createMutationEvidenceRecovery } from "../session/mutation-evidence-recovery.js"

const log = Log.create({ service: "runtime-chat-kernel" })

export interface RuntimeChatKernel {
  readonly stateReleaseResources: readonly string[]
  readonly runtime: EventStoreRuntime
  readonly eventReader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventStore: RuntimeEventState
  readonly eventWriter: AsyncEventWriter
  readonly manager: SessionManager
  readonly sessionStore: SessionStore
  readonly workflowHosts: WorkflowHosts
  /** The host of the handed-over commands no session host holds; the runtime
   *  supervisor's stop closes it. */
  readonly keeper: CommandKeeper
  readonly bus: RuntimeUiBus<RuntimeUiPatch>
  readonly transcriptCache: TranscriptProjectionCache
  readonly projections: Awaited<ReturnType<typeof createFrontendProjections>>
}

/** Opens the durable state needed to materialize and write a chat before optional
 * runtime services start. The caller's ownership ledger remains the single
 * shutdown authority for every resource acquired here. */
export async function createRuntimeChatKernel(
  directories: ProjectDirectories & { readonly executionCwd: string },
  scope: RuntimeOwnership,
  backgroundLane: RuntimeBackgroundLane,
): Promise<RuntimeChatKernel> {
  const workspaceState = scope.own("workspace-state-generation", prepareWorkspaceState(directories), (state) => { state.generation.release() })
  log.info("runtime workspace prepared", { dbFile: workspaceState.dbFile })
  startupTrace("runtime workspace prepared")

  const runtime = scope.own("event-store-runtime", ManagedRuntime.make(EventStoreLive(workspaceState.dbFile,
    (reader, writer) => createMutationEvidenceRecovery(reader, writer).reader)), (owned) => owned.dispose())
  startupTrace("runtime event store live made")
  const eventReader = await runtime.runPromise(EventReaderService)
  const eventStore = await runtime.runPromise(EventStoreService)
  startupTrace("runtime event reader ready")
  const eventWriter = await runtime.runPromise(EventStoreWriterService)
  startupTrace("runtime event writer ready")
  scope.own("event-store-writer-lane", await runtime.runPromise(EventStoreWriterLaneService), (lane) =>
    loggedOperation({ log, operation: "flush durable state", fields: { projectRoot: directories.projectRoot } }, async () => {
      const result = await lane.dispose()
      log.info("event-store writer lane drain done", { kind: result.kind, acked: result.acked.length })
      if (result.kind === "failed") throw new Error(`event-store writer lane drain failed: ${result.error.message}`)
    }))
  startupTrace("runtime writer lane ready")

  const projectionReader = eventReader
  const manager = createSessionManager({
    projectRoot: directories.projectRoot,
    executionCwd: directories.executionCwd,
    projectionReader,
    writer: eventWriter,
  })
  return assembleRuntimeChatKernel(directories.projectRoot, scope, backgroundLane, {
    runtime, eventReader, projectionReader, eventStore, eventWriter, manager,
    stateReleaseResources: ["event-store-runtime", "workspace-state-generation"],
  })
}

/** Builds the runner pool and client projections over an explicitly owned state authority. */
export async function assembleRuntimeChatKernel(
  projectRoot: string,
  scope: RuntimeOwnership,
  backgroundLane: RuntimeBackgroundLane,
  state: Pick<RuntimeChatKernel, "runtime" | "eventReader" | "projectionReader" | "eventStore" | "eventWriter" | "manager" | "stateReleaseResources">,
): Promise<RuntimeChatKernel> {
  const { runtime, eventReader, projectionReader, eventStore, eventWriter, manager } = state
  const sessionStore = scope.own(
    "session-store",
    createSessionStore(runtime, projectionReader),
    (store) => store.disposeAll(),
  )
  const workflowHosts = scope.own("workflow-hosts", workflowRunOwner().hosts({
    runtime, projectionReader, attachChildProjection: childSessionProjectionAttachment(sessionStore),
  }), (hosts) => hosts.disposeAll(() => "runtime"))
  const keeper = createCommandKeeper({ reader: eventReader, writer: eventWriter, manager })
  const bus = scope.own("runtime-ui-bus", createRuntimeUiBus(), (owned) => owned.clear())
  const transcriptCache = scope.own(
    "transcript-cache",
    createTranscriptProjectionCache({ sessionStore, reader: eventReader, projectionReader, projectRoot }),
    (owned) => owned.dispose(),
  )
  const projections = await createFrontendProjections(scope, {
    sessionStore,
    manager,
    projectRoot,
    eventReader,
    projectionReader,
    onStored: eventStore.onStored,
    bus,
    transcriptCache,
    backgroundLane,
    keeper,
  })
  startupTrace("runtime session store created")
  startupTrace("runtime session manager created")
  return { ...state, sessionStore, workflowHosts, keeper, bus, transcriptCache, projections }
}
