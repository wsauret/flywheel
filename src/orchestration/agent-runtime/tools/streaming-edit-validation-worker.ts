import { resolve } from "node:path"
import { FILE_EDIT_LIMITS } from "../../../infra/file-edit/contract.js"
import type { FileSnapshot } from "../../../infra/file-edit/patch-plan.js"
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js"
import type {
  StreamingEditValidationWorkerIdentity,
  StreamingEditValidationWorkerReply,
  StreamingEditValidationWorkerRequest,
} from "./streaming-edit-validation-protocol.js"
import { StreamingEditValidator } from "./streaming-edit-validator.js"

interface SnapshotRetention {
  snapshotBytes: number
}

interface LiveValidator {
  readonly validator: StreamingEditValidator
  readonly retention: SnapshotRetention
}

const validators = new Map<string, LiveValidator>()
let retainedSnapshotBytes = 0

function key(identity: StreamingEditValidationWorkerIdentity): string {
  return identity.handleToken
}

function captureSnapshot(retention: SnapshotRetention, executionCwd: string, path: string): FileSnapshot {
  const authority = RetainedFileEditAuthority.admitWritable(resolve(executionCwd, path))
  try {
    const snapshot = {
      path,
      ...(authority.snapshot ? { content: authority.strictText() } : {}),
    }
    const bytes = Buffer.byteLength(snapshot.path) + Buffer.byteLength(snapshot.content ?? "")
    if (retainedSnapshotBytes + bytes > FILE_EDIT_LIMITS.maxOutputBytes) {
      throw new Error("streaming validation snapshot budget unavailable")
    }
    retention.snapshotBytes += bytes
    retainedSnapshotBytes += bytes
    return snapshot
  } finally {
    authority.close()
  }
}

function release(validatorKey: string): void {
  const live = validators.get(validatorKey)
  if (!live) return
  live.validator.dispose()
  retainedSnapshotBytes -= live.retention.snapshotBytes
  validators.delete(validatorKey)
}

globalThis.addEventListener("message", async (event: MessageEvent<StreamingEditValidationWorkerRequest>) => {
  const request = event.data
  const validatorKey = key(request)
  if (request.type === "drop") {
    release(validatorKey)
    return
  }

  let live = validators.get(validatorKey)
  if (!live) {
    const retention: SnapshotRetention = { snapshotBytes: 0 }
    const validator = new StreamingEditValidator(request.tool, (path) => Promise.resolve(captureSnapshot(retention, request.executionCwd, path)))
    const owned: LiveValidator = { validator, retention }
    live = owned
    validators.set(validatorKey, live)
  }
  const result = await live.validator.append(request.suffix)
  const advice = result.status === "advisory"
    ? { type: "set", message: result.message } as const
    : { type: "clear" } as const
  globalThis.postMessage({
    type: "result",
    handleToken: request.handleToken,
    attemptToken: request.attemptToken,
    toolToken: request.toolToken,
    inputToken: request.inputToken,
    sequence: request.sequence,
    status: result.status,
    advice,
  } satisfies StreamingEditValidationWorkerReply, [])
  if (result.status === "unavailable") release(validatorKey)
})

globalThis.postMessage({ type: "ready" } satisfies StreamingEditValidationWorkerReply, [])
