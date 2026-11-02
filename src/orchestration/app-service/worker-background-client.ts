import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { RpcClient, RpcClientError, RpcGroup } from "effect/unstable/rpc"
import { isAbortError } from "../../infra/abort.js"
import { createBoundedWorkerSpawner, WorkerGenerationBudgetExhausted } from "../../infra/bounded-worker-spawner.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { DebugLog } from "../../infra/debug-log.js"
import { Log } from "../../infra/log.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { bunWorkerClientLayers } from "./bun-worker-rpc.js"
import type { RuntimeSessionDetailQuery, RuntimeSessionDetailResult } from "../../protocol/session-detail-protocol-types.js"
import { RuntimeBackgroundRpc, type RuntimeBackgroundSummaryResult } from "../../protocol/runtime-protocol-schemas.js"
import type { SessionFileChangeCounts } from "../../protocol/session-changes-protocol-types.js"
import { protocolBackgroundSchema, type ProtocolBackgroundDomain, type ProtocolBackgroundSnapshot } from "../../protocol/modules.js"
import type { RuntimeBackgroundWorkerInit } from "./runtime-background-worker.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { TranscriptSearchRequest, TranscriptSearchResult } from "../../protocol/transcript-protocol-types.js"

type RuntimeBackgroundProtocolClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof RuntimeBackgroundRpc>,
  RpcClientError.RpcClientError
>

class RuntimeBackgroundProtocolClientService extends Context.Service<
  RuntimeBackgroundProtocolClientService,
  RuntimeBackgroundProtocolClient
>()("flywheel/RuntimeBackgroundProtocolClient") {}

export interface RuntimeBackgroundClient {
  warm(): Promise<void>
  snapshot(): Promise<RuntimeBackgroundSummaryResult>
  sessionSummaryImmediate(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  waitForTotals(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  sessionDetail(query: RuntimeSessionDetailQuery): Promise<RuntimeSessionDetailResult>
  sessionChangeSummary(sessionId: string): Promise<SessionFileChangeCounts>
  moduleSnapshot<Domain extends ProtocolBackgroundDomain>(domain: Domain, sessionId: string): Promise<ProtocolBackgroundSnapshot<Domain>>
  recall(conversationId: string, contract: RecallInput): Promise<RecallResult>
  transcriptSearch(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>
  close(): Promise<void>
}

const log = Log.create({ service: "runtime-background-client" })

export interface WorkerBackgroundProcessClient {
  acquire(projectRoot: string): RuntimeBackgroundClient
  dispose(): Promise<void>
}

interface ProcessBackgroundClientOptions {
  readonly workerUrl: string
  readonly logBase: string
}

/** Owns one bounded Worker allocator for the account process and lends
 * project-bound readers. Zero open projects does not reset its generation budget. */
export function createProcessBackgroundClient(options: ProcessBackgroundClientOptions): WorkerBackgroundProcessClient {
  let workerBudgetExhaustionReported = false
  let workerAllocated = false
  const allocateWorker = createBoundedWorkerSpawner("runtime-background")
  const spawn = (): Worker => {
    try {
      const worker = allocateWorker(options.workerUrl, { name: "flywheel-runtime-background", ref: false })
      workerAllocated = true
      DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "background" } })
      return worker
    } catch (error) {
      const exhausted = error instanceof WorkerGenerationBudgetExhausted
      if (!exhausted || !workerBudgetExhaustionReported) {
        workerBudgetExhaustionReported ||= exhausted
        log.warn(exhausted ? "runtime background Worker budget exhausted" : "runtime background Worker failed to start", {
          error: errorMessage(error),
          errorDetail: errorDetail(error),
        })
      }
      throw error
    }
  }
  const initializeWorker = (worker: Worker): void => {
    // Bun Workers do not observe process.env mutations made after process boot,
    // so the owner passes the level captured when it allocates the Worker. The
    // Worker always receives a level, so only this process warns about a value
    // that names none.
    const init: RuntimeBackgroundWorkerInit = {
      flywheel: "background.init",
      logBase: options.logBase,
      logLevel: Log.envLevel() ?? "INFO",
    }
    worker.postMessage(init, [])
  }
  const runtime = ManagedRuntime.make(
    Layer.effect(RuntimeBackgroundProtocolClientService, RpcClient.make(RuntimeBackgroundRpc)).pipe(
      Layer.provide(RpcClient.layerProtocolWorker({ size: 1, concurrency: 8 })),
      Layer.provide(bunWorkerClientLayers(spawn, initializeWorker)),
    ),
  )
  const references = new Map<string, number>()
  const releases = createOrderedLane()
  let disposed = false
  let disposal: Promise<void> | undefined

  /** Disposing the runtime interrupts every call it still carries. An
   *  interruption is the owner's shutdown withdrawing the read, not a failed
   *  read, so it rejects as an abort that each caller classifies through
   *  `isAbortError`. Every other failure rejects as `runPromise` would. */
  async function call<A, E>(run: (client: RuntimeBackgroundProtocolClient) => Effect.Effect<A, E>): Promise<A> {
    const exit = await runtime.runPromiseExit(Effect.flatMap(RuntimeBackgroundProtocolClientService, run))
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasInterruptsOnly(exit.cause)) throw new DOMException("Runtime background call interrupted", "AbortError")
    throw Cause.squash(exit.cause)
  }

  return {
    acquire(projectRoot) {
      if (disposed) throw new Error("Runtime background process client is disposed")
      references.set(projectRoot, (references.get(projectRoot) ?? 0) + 1)
      let closed = false
      // Closing this client releases its project in the Worker, which cancels
      // the reads still running there and refuses the ones that arrive after.
      // Whatever a call meets once its client closed is that close, not a
      // failed read, so it rejects as an abort, as a call the client refuses
      // itself does. A client that is still open reports every failure as it is.
      const projectCall = async <A, E>(run: (client: RuntimeBackgroundProtocolClient) => Effect.Effect<A, E>): Promise<A> => {
        if (closed) throw new DOMException("Runtime background client is closed", "AbortError")
        try {
          return await call(run)
        } catch (error) {
          if (closed && !isAbortError(error)) throw new DOMException(`Runtime background client closed during the call: ${errorMessage(error)}`, "AbortError")
          throw error
        }
      }
      return {
        warm: () => projectCall(() => Effect.void),
        snapshot: () => projectCall((client) => client.RuntimeBackgroundSnapshot({ projectRoot })),
        sessionSummaryImmediate: (sessionIds) => projectCall((client) => client.RuntimeBackgroundSessionSummaryImmediate({ projectRoot, sessionIds })),
        waitForTotals: (sessionIds) => projectCall((client) => client.RuntimeBackgroundWaitForTotals({ projectRoot, sessionIds })),
        sessionDetail: ({ sessionId }) => projectCall((client) => client.RuntimeBackgroundSessionDetail({ projectRoot, sessionId })),
        sessionChangeSummary: (sessionId) => projectCall((client) => client.RuntimeBackgroundSessionChangeSummary({ projectRoot, sessionId })),
        moduleSnapshot: (domain, sessionId) => projectCall((client) => client.RuntimeBackgroundModuleSnapshot({ projectRoot, domain, sessionId }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(protocolBackgroundSchema(domain))))),
        recall: (conversationId, contract) => projectCall((client) => client.RuntimeBackgroundRecall({ projectRoot, conversationId, contract })),
        transcriptSearch: (request) => projectCall((client) => client.RuntimeBackgroundTranscriptSearch({ projectRoot, request })),
        close() {
          if (closed) return releases.settled()
          closed = true
          return releases.run(async () => {
            const remaining = (references.get(projectRoot) ?? 1) - 1
            if (remaining > 0) {
              references.set(projectRoot, remaining)
              return
            }
            references.delete(projectRoot)
            try {
              await call((client) => client.RuntimeBackgroundReleaseProject({ projectRoot }))
            } catch (err) {
              log.warn("runtime background project release failed", { projectRoot, error: errorMessage(err), errorDetail: errorDetail(err) })
            }
          })
        },
      }
    },
    dispose() {
      disposed = true
      disposal ??= releases.settled().then(async () => {
        if (references.size !== 0) {
          throw new Error(`Runtime background process client still has ${references.size} project reference(s)`)
        }
        if (workerAllocated) {
          try {
            await call((client) => client.RuntimeBackgroundShutdown())
          } catch (err) {
            log.warn("runtime background Worker shutdown failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
          }
        }
        try {
          await runtime.dispose()
        } catch (err) {
          log.warn("runtime background Worker dispose failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
        }
      })
      return disposal
    },
  }
}
