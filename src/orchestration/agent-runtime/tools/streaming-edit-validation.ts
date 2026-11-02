import { createBoundedWorkerSpawner } from "../../../infra/bounded-worker-spawner.js"
import { embeddedEntrySpecifier, runsThroughBun } from "../../../infra/cli-subprocess.js"
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "../../../infra/output/partial-json.js"
import { terminateWorker } from "../../../infra/worker-termination.js"
import type {
  StreamingEditValidationAdviceEvent,
  StreamingEditValidationAppend,
  StreamingEditValidationIdentity,
  StreamingEditValidationStart,
  StreamingEditValidationWorkerIdentity,
  StreamingEditValidationWorkerReply,
  StreamingEditValidationWorkerRequest,
} from "./streaming-edit-validation-protocol.js"

interface LiveInput extends StreamingEditValidationStart, StreamingEditValidationWorkerIdentity {
  readonly executionCwd: string
  readonly onAdvice: (event: StreamingEditValidationAdviceEvent) => void
  suffix: string
  nextSequence: number
  acceptedBytes: number
}

interface InFlight extends StreamingEditValidationWorkerIdentity {
  readonly sequence: number
}

export interface StreamingEditValidationWorker {
  onmessage: ((event: MessageEvent<StreamingEditValidationWorkerReply>) => void) | null
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  postMessage(message: StreamingEditValidationWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

interface StreamingEditValidationServiceOptions {
  readonly spawnWorker?: (specifier: string | URL, options?: WorkerOptions) => StreamingEditValidationWorker | Promise<StreamingEditValidationWorker>
  readonly workerSpecifier?: string | URL
}

interface StreamingEditValidationTurn {
  start(input: StreamingEditValidationStart): void
  append(input: StreamingEditValidationAppend): void
  retire(input: StreamingEditValidationIdentity): void
  reset(attemptToken: string): void
}

export interface StreamingEditValidationService {
  openTurn(options: {
    readonly executionCwd: string
    readonly onAdvice: (event: StreamingEditValidationAdviceEvent) => void
  }): StreamingEditValidationTurn
  dispose(): Promise<void>
}

function workerSpecifier(): string {
  return runsThroughBun(process.execPath)
    ? new URL("streaming-edit-validation-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "streaming-edit-validation-worker.js")
}

function callerKey(identity: StreamingEditValidationIdentity): string {
  return `${identity.attemptToken}\0${identity.toolToken}\0${identity.inputToken}`
}

function sameIdentity(left: StreamingEditValidationWorkerIdentity, right: StreamingEditValidationWorkerIdentity): boolean {
  return left.handleToken === right.handleToken
    && left.attemptToken === right.attemptToken
    && left.toolToken === right.toolToken
    && left.inputToken === right.inputToken
}

/** Owns one optional validation Worker for the runtime lifetime. Validation never gates tool execution. */
export function createStreamingEditValidationService(
  options: StreamingEditValidationServiceOptions = {},
): StreamingEditValidationService {
  const spawn = options.spawnWorker ?? createBoundedWorkerSpawner("streaming-edit-validation")
  const specifier = options.workerSpecifier ?? workerSpecifier()
  const live = new Map<string, LiveInput>()
  let liveInputBytes = 0
  let nextHandle = 0
  let worker: StreamingEditValidationWorker | undefined
  let starting: Promise<void> | undefined
  let inFlight: InFlight | undefined
  let disposed = false
  let unavailable = false

  const fail = (): void => {
    unavailable = true
    inFlight = undefined
    liveInputBytes = 0
    for (const input of live.values()) input.suffix = ""
  }

  const pump = (): void => {
    if (disposed || unavailable || inFlight) return
    if (!worker) {
      if (starting) return
      const attempt = Promise.resolve()
        .then(() => spawn(specifier, { name: "streaming-edit-validation", ref: false }))
        .then((created) => {
          if (disposed) {
            worker = created
            return
          }
          worker = created
          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: this runtime-owned worker has one typed reply consumer.
          created.onmessage = (event) => {
            const reply = event.data
            if (reply.type !== "result") return
            const current = inFlight
            if (!current || current.sequence !== reply.sequence || !sameIdentity(current, reply)) return
            inFlight = undefined
            const input = live.get(reply.handleToken)
            if (input && sameIdentity(input, reply)) {
              input.onAdvice({
                attemptToken: reply.attemptToken,
                toolToken: reply.toolToken,
                inputToken: reply.inputToken,
                advice: reply.advice,
              })
              if (reply.status === "unavailable") {
                liveInputBytes -= input.acceptedBytes
                live.delete(input.handleToken)
              }
            }
            pump()
          }
          created.addEventListener("error", fail)
          created.addEventListener("close", () => {
            if (!disposed) fail()
          })
          pump()
        })
        .catch(fail)
        .finally(() => {
          if (starting === attempt) starting = undefined
        })
      starting = attempt
      return
    }

    for (const input of live.values()) {
      if (input.suffix.length === 0) continue
      const suffix = input.suffix
      input.suffix = ""
      const sequence = ++input.nextSequence
      inFlight = {
        handleToken: input.handleToken,
        attemptToken: input.attemptToken,
        toolToken: input.toolToken,
        inputToken: input.inputToken,
        sequence,
      }
      const request: StreamingEditValidationWorkerRequest = {
        type: "append",
        handleToken: input.handleToken,
        attemptToken: input.attemptToken,
        toolToken: input.toolToken,
        inputToken: input.inputToken,
        tool: input.tool,
        executionCwd: input.executionCwd,
        sequence,
        suffix,
      }
      try {
        worker.postMessage(request, [])
      } catch {
        fail()
      }
      return
    }
  }

  const retireHandle = (handleToken: string): void => {
    const input = live.get(handleToken)
    if (!input) return
    liveInputBytes -= input.acceptedBytes
    live.delete(handleToken)
    if (worker) {
      try {
        worker.postMessage({
          type: "drop",
          handleToken,
          attemptToken: input.attemptToken,
          toolToken: input.toolToken,
          inputToken: input.inputToken,
        } satisfies StreamingEditValidationWorkerRequest, [])
      } catch {
        fail()
      }
    }
  }

  return {
    openTurn: ({ executionCwd, onAdvice }) => {
      const handles = new Map<string, string>()
      const retire = (identity: StreamingEditValidationIdentity): void => {
        const inputKey = callerKey(identity)
        const handleToken = handles.get(inputKey)
        if (!handleToken) return
        handles.delete(inputKey)
        retireHandle(handleToken)
      }
      return {
        start: (input) => {
          if (disposed || unavailable) return
          retire(input)
          const handleToken = `validation-${++nextHandle}`
          handles.set(callerKey(input), handleToken)
          live.set(handleToken, { ...input, handleToken, executionCwd, onAdvice, suffix: "", nextSequence: 0, acceptedBytes: 0 })
        },
        append: (append) => {
          if (disposed || unavailable || append.suffix.length === 0) return
          const input = live.get(handles.get(callerKey(append)) ?? "")
          if (!input) return
          const bytes = Buffer.byteLength(append.suffix)
          if (liveInputBytes + bytes > MAX_STREAMING_TOOL_INPUT_BYTES) {
            retire(append)
            return
          }
          input.suffix += append.suffix
          input.acceptedBytes += bytes
          liveInputBytes += bytes
          pump()
        },
        retire,
        reset: (attemptToken) => {
          for (const [inputKey, handleToken] of handles) {
            const input = live.get(handleToken)
            if (input?.attemptToken === attemptToken) {
              handles.delete(inputKey)
              retireHandle(handleToken)
            }
          }
        },
      }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      live.clear()
      liveInputBytes = 0
      await starting
      const active = worker
      worker = undefined
      if (active) await terminateWorker(active)
    },
  }
}
