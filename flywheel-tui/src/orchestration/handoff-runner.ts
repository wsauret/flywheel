import type { ZodType } from "zod"
import type { Engine } from "./engines/core/types.js"
import type { NDJSONEvent } from "../infra/ndjson-event-types.js"
import type { ToolAction } from "../infra/workflow-types.js"
import type { AuthContext } from "../infra/auth/auth-context.js"
import { readHandoff } from "../workflows/queue/shared/handoff-reader.js"

class HandoffRunnerTimeoutError extends Error {
  readonly name = "HandoffRunnerTimeoutError"
  constructor(readonly timeoutMs: number) {
    super(`Handoff runner timed out after ${timeoutMs}ms`)
  }
}

class HandoffRunnerAbortedError extends Error {
  readonly name = "HandoffRunnerAbortedError"
  constructor() {
    super("Handoff runner aborted by signal")
  }
}

interface InvokeHandoffOptions<THandoff> {
  engine: Engine
  model: string
  auth: AuthContext
  cwd: string
  sessionDir?: string
  systemPrompt?: string
  effort?: string
  toolActions?: ReadonlyArray<ToolAction>
  prompt: string
  handoffPath: string
  // Zod's ZodType<Output, Def, Input> requires `any` for Def/Input when schemas
  // use .passthrough() (Input type differs from Output type).
  handoffSchema: ZodType<THandoff, any, any>
  onEvent?: (event: NDJSONEvent) => void
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export async function invokeHandoffRunner<THandoff>(
  options: InvokeHandoffOptions<THandoff>,
): Promise<THandoff> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const onEvent = options.onEvent ?? (() => {})

  const runner = options.engine.createRunner({
    model: options.model,
    auth: options.auth,
    systemPrompt: options.systemPrompt,
    effort: options.effort,
    toolActions: options.toolActions,
    cwd: options.cwd,
    sessionDir: options.sessionDir,
    handoffPath: options.handoffPath,
    signal: options.signal,
    onEvent,
  })

  runner.send(options.prompt)

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs)
  })

  const abortPromise = new Promise<"aborted">((resolve) => {
    if (!options.signal) return
    if (options.signal.aborted) {
      resolve("aborted")
      return
    }
    options.signal.addEventListener("abort", () => resolve("aborted"), { once: true })
  })

  try {
    // runner.abort() is idempotent — both timeout and signal paths may call it.
    const winner = await Promise.race([runner.done, timeoutPromise, abortPromise])
    if (winner === "timeout") {
      runner.abort()
      throw new HandoffRunnerTimeoutError(timeoutMs)
    }
    if (winner === "aborted") {
      runner.abort()
      throw new HandoffRunnerAbortedError()
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }

  return readHandoff(options.handoffPath, options.handoffSchema)
}
