import { realpath } from "node:fs/promises"
import { Schema } from "effect"
import { readAppVersion } from "../../infra/app-version.js"
import { errorMessage } from "../../infra/error-message.js"
import {
  ACP_PROTOCOL_VERSION, AcpCancelParamsSchema, AcpInboundSchema, AcpInitializeParamsSchema, AcpNewSessionParamsSchema, AcpPromptParamsSchema,
  JSON_RPC_ERROR, acpBlockUpdates, acpError, acpPromptUsage, acpResult, acpToolOpen, acpUpdate, acpUsageUpdate,
  type AcpStreamed, type JsonRpcId,
} from "../../protocol/acp.js"
import type { FrontendEvent, FrontendMutation, FrontendOutputBlock, RuntimeEventFrame } from "../../protocol/app-service-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { isBudgetPayload } from "../../protocol/budget-protocol-types.js"
import { createTranscriptStore, type TranscriptStore } from "../../protocol/client/transcript-store.js"
import type { PendingQuestionView } from "../../protocol/question-protocol-types.js"
import type { HeadlessChatChannel, HeadlessChatFraming } from "./run-headless-chat.js"

/** One read of the output a recovered window skipped over. */
const GAP_PAGE = { maxBlocks: 200, maxBytes: 4 * 1024 * 1024, includeThinkingContent: true } as const

/** Agent Client Protocol version 1 over headless chat (protocol/acp.ts). The
 *  channel's root chat is the one ACP session: `session/new` names it, and
 *  refuses a second one or a `cwd` other than `executionCwd`, where the
 *  session's tools run. A prompt sends a message, or answers the open
 *  question with the prompt's text, and is answered when the channel settles.
 *  A turn that ends on an open question streams the question as the agent's
 *  message and ends the prompt; nothing answers it but the next prompt. */
export function acpFraming(executionCwd: string): HeadlessChatFraming {
  let transcript: TranscriptStore | undefined
  return {
    open: async (channel) => openAcpSession(channel, await readAppVersion(), executionCwd, (store) => { transcript = store }),
    final: () => {
      transcript?.dispose()
      return undefined
    },
  }
}

function openAcpSession(channel: HeadlessChatChannel, version: string, executionCwd: string, adopt: (transcript: TranscriptStore) => void) {
  const sessionId = channel.sessionId
  const frameListeners = new Set<(event: FrontendEvent) => void>()
  let transcript: TranscriptStore | undefined
  const streamed = new Map<string, AcpStreamed>()
  // Every block identity this session passed through the stream. A recovered
  // window whose first block is not here skipped output that never streamed.
  const seen = new Set<string>()
  // Updates go out in this one order, so the output a gap read recovers
  // streams before the live output that follows it.
  let streaming: Promise<void> = Promise.resolve()
  let prompting = false
  let cancelled = false
  let question: PendingQuestionView | undefined
  // The last error notice the running prompt streamed: why its turn failed.
  let notice: string | undefined

  const send = (lines: () => Promise<readonly string[]> | readonly string[]): void => {
    streaming = streaming.then(async () => { for (const line of await lines()) await channel.write(line) })
    channel.hold(streaming)
  }

  const updatesFor = (blocks: readonly FrontendOutputBlock[]): string[] => blocks.flatMap((block) => {
    const identity = blockIdentity(block)
    seen.add(identity)
    const next = acpBlockUpdates(block, streamed.get(identity))
    if (next.streamed !== undefined) streamed.set(identity, next.streamed)
    if (block.kind === "system" && next.updates.length > 0) notice = block.message
    return next.updates.map((update) => acpUpdate(sessionId, update))
  })

  /** The current blocks before `read` that a gap can have changed, oldest
   *  first: back to the last streamed block, whose final characters can be
   *  lost, and back to every tool call still streamed as running, whose
   *  result can be lost. Resident blocks outside a read are not evidence: a
   *  merged read keeps the versions the lost deltas left behind. Blocks
   *  already streamed in full stream nothing again. */
  const skippedBefore = async (read: readonly FrontendOutputBlock[]): Promise<FrontendOutputBlock[]> => {
    const pages: (readonly FrontendOutputBlock[])[] = []
    const open = new Set([...streamed].flatMap(([identity, sent]) => acpToolOpen(sent) ? [identity] : []))
    const reach = (page: readonly FrontendOutputBlock[]) => {
      for (const block of page) open.delete(blockIdentity(block))
      return page.some((block) => seen.has(blockIdentity(block)))
    }
    let first = read[0]
    let more = true
    let bounded = reach(read)
    while (first !== undefined && more && (!bounded || open.size > 0)) {
      const page = await channel.client.query({ type: "outputRange", sessionId, request: { anchor: { kind: "beforeBlock", blockId: blockIdentity(first) }, ...GAP_PAGE } })
      if (page.kind !== "ok") break
      pages.unshift(page.blocks)
      bounded = reach(page.blocks) || bounded
      first = page.blocks[0]
      more = page.window.hasBefore
    }
    return pages.flat()
  }

  /** The shared transcript store owns intake order, absolute coordinates, and
   *  recovery. Headless chat holds one lane for its whole run, and its event
   *  delivery carries every session's output, so the lane opens at once and
   *  an output watch has nothing to start. */
  const openTranscript = (): TranscriptStore => {
    const store = createTranscriptStore({
      connection: {
        query: (query) => channel.client.query(query),
        subscribe: (listener) => {
          frameListeners.add(listener)
          return () => { frameListeners.delete(listener) }
        },
        onLane: (listener) => {
          listener(1)
          return () => {}
        },
        watchOutput: () => () => {},
      },
      sessionId,
      includeThinkingContent: () => true,
    })
    store.onChange((change) => {
      if (change.kind === "deltas") {
        const blocks = change.replaced.map(({ next }) => next)
        send(() => updatesFor(blocks))
      } else if (change.kind === "window") {
        const { adopted } = change
        send(async () => updatesFor([...await skippedBefore(adopted), ...adopted]))
      }
    })
    return store
  }

  const frame = (event: RuntimeEventFrame): readonly string[] => {
    if (transcript === undefined || event.type !== "patch") return []
    for (const listener of frameListeners) listener(event)
    const { cursor, payload } = event.patch
    if (cursor.scope === "session" && cursor.sessionId === sessionId && isBudgetPayload(payload) && payload.kind === "budget.updated") {
      const update = acpUsageUpdate(payload.budget)
      if (update) send(() => [acpUpdate(sessionId, update)])
    }
    return []
  }

  const answerPrompt = async (id: JsonRpcId, store: TranscriptStore): Promise<void> => {
    const outcome = await channel.settle()
    // A read the store already had out when the turn settled can answer from
    // before its last output, and a refresh joins it, so the second refresh
    // reads after the settlement.
    await store.refresh()
    await store.refresh()
    await streaming
    const lines: string[] = []
    // The settled budget reaches the client before the response that ends
    // its prompt, which a live budget patch can still be behind.
    const budget = (await channel.client.query({ type: "budgetSnapshot", sessionIds: [sessionId] })).views[0]?.view
    const usage = budget ? acpUsageUpdate(budget) : undefined
    if (usage) lines.push(acpUpdate(sessionId, usage))
    // The settled read names the open question, which a live patch can still
    // be on its way to report.
    question = outcome === "input_required"
      ? (await channel.client.query({ type: "questionSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? undefined
      : undefined
    prompting = false
    if (outcome === "failed" || outcome === "incomplete" && !cancelled) {
      lines.push(acpError(id, JSON_RPC_ERROR.internal, notice ?? "The turn ended before it completed"))
    } else {
      // Usage stats come from the Usage module; without it the response
      // carries no token counts.
      const stats = await channel.client.query({ type: "usage.stats", sessionId }).catch(() => undefined)
      lines.push(acpResult(id, { stopReason: cancelled ? "cancelled" : "end_turn", ...(stats ? { usage: acpPromptUsage(stats.totals.tokens) } : {}) }))
    }
    send(() => lines)
    await streaming
  }

  const prompt = async (id: JsonRpcId, text: string, store: TranscriptStore) => {
    const command: FrontendMutation = question
      ? { type: "question.answer", sessionId, toolUseId: question.toolUseId, answers: Object.fromEntries(question.questions.map((entry) => [entry.question, { kind: "freeform" as const, text }])) }
      : { type: "session.send", sessionId, input: text }
    notice = undefined
    const result = await channel.client.dispatch(command)
    if (!result.ok) return { lines: [acpError(id, JSON_RPC_ERROR.internal, result.error)], submitted: false }
    prompting = true
    cancelled = false
    channel.hold(answerPrompt(id, store))
    return { lines: [], submitted: true }
  }

  const request = async (line: string): Promise<{ readonly lines: readonly string[]; readonly submitted: boolean }> => {
    const refuse = (id: JsonRpcId | null, code: number, message: string) => ({ lines: [acpError(id, code, message)], submitted: false })
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return refuse(null, JSON_RPC_ERROR.parse, "Invalid JSON") }
    const inbound = Schema.decodeUnknownOption(AcpInboundSchema)(raw)
    if (inbound._tag === "None") return refuse(null, JSON_RPC_ERROR.invalidRequest, "Invalid JSON-RPC 2.0 message")
    const { id, method, params } = inbound.value
    if (id === undefined) {
      const cancel = method === "session/cancel" ? Schema.decodeUnknownOption(AcpCancelParamsSchema)(params) : undefined
      if (cancel?._tag === "Some" && cancel.value.sessionId === sessionId && prompting) {
        cancelled = true
        await channel.client.dispatch({ type: "chat.interrupt", sessionId })
      }
      return { lines: [], submitted: false }
    }
    try {
      switch (method) {
        case "initialize": {
          if (Schema.decodeUnknownOption(AcpInitializeParamsSchema)(params)._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "initialize requires protocolVersion")
          return { lines: [acpResult(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false },
            agentInfo: { name: "flywheel", title: "Flywheel", version },
            authMethods: [],
          })], submitted: false }
        }
        case "session/new": {
          const decoded = Schema.decodeUnknownOption(AcpNewSessionParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/new requires cwd and mcpServers")
          if (transcript !== undefined) return refuse(id, JSON_RPC_ERROR.invalidRequest, "This agent serves one session per process")
          const cwd = await realpath(decoded.value.cwd).catch(() => undefined)
          if (cwd !== executionCwd) return refuse(id, JSON_RPC_ERROR.invalidParams, `This agent runs in ${executionCwd}; start it in ${decoded.value.cwd} to work there`)
          transcript = openTranscript()
          adopt(transcript)
          return { lines: [acpResult(id, { sessionId })], submitted: false }
        }
        case "session/prompt": {
          const decoded = Schema.decodeUnknownOption(AcpPromptParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/prompt accepts text content blocks only")
          if (transcript === undefined || decoded.value.sessionId !== sessionId) return refuse(id, JSON_RPC_ERROR.invalidParams, `Unknown session: ${decoded.value.sessionId}`)
          if (prompting) return refuse(id, JSON_RPC_ERROR.invalidRequest, "A prompt is already running in this session")
          return await prompt(id, decoded.value.prompt.map((block) => block.text).join("\n"), transcript)
        }
        default:
          return refuse(id, JSON_RPC_ERROR.methodNotFound, `Method not found: ${method}`)
      }
    } catch (error) {
      return refuse(id, JSON_RPC_ERROR.internal, errorMessage(error))
    }
  }

  return { frame, request }
}
