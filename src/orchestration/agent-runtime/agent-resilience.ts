import { Log } from "../../infra/log.js"
import { DebugLog } from "../../infra/debug-log.js"
import { PersistenceWriteRefused } from "../../infra/event-store-types.js"
import type { ConnectionState } from "../../infra/output-blocks.js"
import { asNoticePresentation } from "../../infra/error-presentation.js"
import type { SessionNoticeOperation } from "../../infra/session-notice.js"
import { failureTerminal, type AgentFailureReason, type AgentRunResult } from "./types.js"
import { boundProviderDetail, providerErrorProse } from "../../infra/llm/provider-error-copy.js"
import { blockedFailureMessage, blockedFailureRecord, describeAgentFailure, type AgentFailureCopy } from "./failure-message.js"
import type { RetryState } from "./llm/retry-budget.js"

const log = Log.create({ service: "agent-resilience" })

export interface ResilienceDeps {
  /** Presentation hooks: chat and workers bind connection state, system
  *  messages, and notices. Headless callers omit all presentation hooks. */
  setConnectionState?: (state: ConnectionState) => void
  pushSystemMessage?: (message: string, level?: "info" | "error") => void
  onNotice?: (operation: SessionNoticeOperation) => void
  signal?: AbortSignal
  originalProviderSessionKey?: string
  /** Context for an explicit user retry after terminal stall exhaustion. */
  initialRequestContext?: string
  /** The caller's recovery policy (`unattended-recovery.ts`). It receives
   *  each failed run with the requests the run served and the turn's
   *  effective cancellation (`signal`), and resolves to the request context
   *  of the next run in the same conversation, or to null to end the turn
   *  with that failure. It owns any wait and its presentation, and every wait
   *  ends when `signal` aborts; an abort ends the turn as aborted. A chat's
   *  policy waits only for model capacity: for every other failure a person
   *  decides there whether to send again. */
  recover?: (failure: AgentFailureReason, servedRequests: number, signal: AbortSignal) => Promise<Pick<RetryState, "requestContext"> | null>
  /** Told the result once the turn's runs have ended, however they ended,
   *  so the recovery policy withdraws a capacity wait it continued from. */
  settle?: (result: AgentRunResult) => Promise<void>
}

type RunFn = (attempt: RetryState) => Promise<AgentRunResult>

/** The one notice scope for provider trouble on this runner. Stream-level
 *  retries (runtime-assembly), resilience-level reconnects, and terminal
 *  blocked notices all publish into it, so a tier transition is a replacement
 *  and any forward path (turn start, first stream event, success, dismissal)
 *  clears the whole failure domain with one resolve. */
export const PROVIDER_NOTICE_SCOPE = "runner:provider"

export function resolveProviderNotices(): SessionNoticeOperation {
  return { type: "resolve-scope", scope: PROVIDER_NOTICE_SCOPE }
}

export function createReconnectNoticeConnectionStateHandler(
  setConnectionState: (state: ConnectionState) => void,
  onNotice?: (operation: SessionNoticeOperation) => void,
): (state: ConnectionState) => void {
  let reconnecting = false
  return (state) => {
    if (state === "reconnecting") reconnecting = true
    setConnectionState(state)
    if (state === "connected" && reconnecting) {
      onNotice?.(resolveProviderNotices())
      reconnecting = false
    }
    if (state === "down") reconnecting = false
  }
}

// Invariant: every terminal exit resolves the provider notice scope, so no
// transient reconnect notice outlives the turn it narrated. The failure
// itself then renders on the one channel its copy registered.
function handleTerminalFailure(reason: AgentFailureReason, deps: ResilienceDeps): void {
  deps.onNotice?.(resolveProviderNotices())
  if (reason.kind === "aborted") return
  if (reason.kind === "local_persistence_error") {
    reportPersistenceWriteRefusal(reason.error, deps)
    return
  }
  const copy = describeAgentFailure(reason)
  log.warn("agent fatal failure", { kind: reason.kind, message: boundProviderDetail(providerErrorProse(copy)) })
  deps.setConnectionState?.("connected")
  publishBlockedFailure(copy, deps)
}

/** Publishes the emergency through live state, even when durable finalization itself failed. */
export function reportPersistenceWriteRefusal(error: PersistenceWriteRefused, deps: ResilienceDeps): void {
  DebugLog.record({
    type: "runtime.persistence_write.refused",
    payload: { requestId: error.requestId ?? null, encodedBytes: error.encodedBytes, limitBytes: error.limitBytes, stage: error.stage ?? null },
  })
  deps.setConnectionState?.("connected")
  publishBlockedFailure(describeAgentFailure({ kind: "local_persistence_error", error }), deps)
}

/** The one publisher for terminal failures. Every failure renders on exactly
 *  the channel its copy registered in `infra/error-presentation.ts` - never
 *  two surfaces for one fact. A notice-registered failure without a notice
 *  channel falls back to the transcript so headless callers lose nothing. */
function publishBlockedFailure(copy: AgentFailureCopy, deps: ResilienceDeps): void {
  const presentation = asNoticePresentation(copy.presentation)
  if (presentation !== undefined && deps.onNotice) {
    deps.onNotice({
      type: "upsert",
      notice: {
        id: `${PROVIDER_NOTICE_SCOPE}:${presentation}`,
        scope: PROVIDER_NOTICE_SCOPE,
        presentation,
        severity: "error",
        title: copy.title,
        message: blockedFailureMessage(copy),
        ...(copy.action ? { action: copy.action } : {}),
      },
    })
    return
  }
  deps.pushSystemMessage?.(blockedFailureRecord(copy), "error")
}

export async function runWithResilience(run: RunFn, deps: ResilienceDeps): Promise<AgentRunResult> {
  const result = await runRecovered(run, deps)
  await deps.settle?.(result)
  return result
}

async function runRecovered(run: RunFn, deps: ResilienceDeps): Promise<AgentRunResult> {
  const { signal, originalProviderSessionKey } = deps
  const setConnectionState = deps.setConnectionState ?? (() => {})
  if (signal?.aborted) {
    deps.onNotice?.(resolveProviderNotices())
    return { durationMs: 0, servedRequests: 0, terminal: { kind: "aborted" } }
  }
  const session = originalProviderSessionKey ? { providerSessionKey: originalProviderSessionKey } : {}
  let result = await run({
    isRetry: false,
    ...(deps.initialRequestContext ? { requestContext: deps.initialRequestContext } : {}),
    ...session,
  })
  let failure = failureTerminal(result.terminal)
  // Each run rebuilds its context from the conversation the failed run
  // recorded, so a recovered run continues it.
  while (failure && failure.kind !== "aborted" && failure.kind !== "local_persistence_error" && deps.recover) {
    if (signal?.aborted) break
    const next = await deps.recover(failure, result.servedRequests, signal ?? new AbortController().signal)
    if (signal?.aborted) {
      deps.onNotice?.(resolveProviderNotices())
      return { durationMs: result.durationMs, servedRequests: result.servedRequests, terminal: { kind: "aborted" } }
    }
    if (next === null) break
    result = await run({ isRetry: true, ...session, ...(next.requestContext ? { requestContext: next.requestContext } : {}) })
    failure = failureTerminal(result.terminal)
  }
  if (failure) handleTerminalFailure(failure, deps)
  else {
    // A fresh success clears a blocked notice left by an earlier run.
    deps.onNotice?.(resolveProviderNotices())
    setConnectionState("connected")
  }
  return result
}
