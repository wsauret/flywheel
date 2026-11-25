// Fixtures of the question-hold tests (PI-INTERACTION-185, ARCH-SESSIONS-050):
// a chat on a real supervisor with a scripted model, and the checks that
// nothing lands after a waiting ask and that its settlement continues one turn.
import { expect } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/substrate/events/output-blocks.js"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/substrate/store/event-store-effect.js"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/substrate/store/event-store-types.js"
import type { ConversationMessage, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { SessionAuthAdmission } from "../../../../src/orchestration/session/metadata/session-auth-profile.js"
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js"
import { createChatRunner } from "../../../../src/orchestration/chat/runner.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/supervisor/runtime-supervisor.js"
import type { RuntimeSupervisor } from "../../../../src/orchestration/app-service/supervisor/runtime-supervisor-types.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input/agent-input-projection.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript/transcript-projection.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { deliverSessionInput } from "../../../../src/orchestration/session/control/messaging/session-input-delivery.js"
import { createSessionViewLoader } from "../../../../src/orchestration/app-service/projections/session-view.js"
import { createSupervisorTestContext, supervisorBaseDeps, testSessionAuthAdmission, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { roleCapture } from "../../../helpers/role-capture.js"

export type Step = (messages: readonly ConversationMessage[]) => readonly ProviderStreamEvent[] | Promise<readonly ProviderStreamEvent[]>

export const askCall = { id: "ask-1", name: "ask_user", input: { context: "Context.", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] } }
export const ask: Step = () => [{ kind: "tool_use", toolCall: askCall }, { kind: "done", stopReason: "tool_use" }]
export const reply = (text: string): Step => () => [{ kind: "text_delta", text, blockKey: "b0" }, { kind: "done", stopReason: "end_turn" }]

/** A model that answers chat request N with step N and records each request. */
function scriptedModel(steps: readonly Step[]) {
  const requests: ConversationMessage[][] = []
  const client = asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      if (options.tools.length === 0) {
        yield { kind: "text_delta", text: "Title", blockKey: "t0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      const index = requests.length
      requests.push(structuredClone(options.messages))
      for (const event of await (steps[index] ?? reply(`reply-${index}`))(options.messages)) yield event
    },
  })
  return { client, requests }
}

function admissionStreamingFrom(client: ReturnType<typeof scriptedModel>["client"], gate?: StartupGate): SessionAuthAdmission<WorkflowDeps> {
  const base = testSessionAuthAdmission()
  const current = base.current("any")
  const createLLMClient = async () => client
  const capture = async () => ({
    ...roleCapture([client.model]),
    admit: () => ({ createLLMClient, createAgent: () => { throw new Error("This capture constructs clients only") } }),
  })
  const admitted = Object.freeze({ ...current, workflowDeps: { ...current.workflowDeps, captureProviderConnection: capture, createAgent: (options: Parameters<WorkflowDeps["createAgent"]>[0]) => newTestRunner(options, createLLMClient, undefined, capture) } })
  const admit = async () => { await (typeof gate === "function" ? gate() : gate); return admitted }
  return { ...base, admitDefaults: admit, admit, current: () => admitted }
}

export interface Chat {
  readonly ctx: SupervisorTestContext
  readonly writer: AsyncEventWriter
  readonly model: ReturnType<typeof scriptedModel>
  supervisor: RuntimeSupervisor
  sessionId: string
  conversationId: string
}

/** `gate` holds every runner startup at auth admission until it resolves. */
/** What each admission of a runner waits for: one promise for all of them,
 *  or a function that each admission asks again. */
type StartupGate = Promise<void> | (() => Promise<void>)

export function newSupervisor(ctx: SupervisorTestContext, model: ReturnType<typeof scriptedModel>, gate?: StartupGate): RuntimeSupervisor {
  const admission = admissionStreamingFrom(model.client, gate)
  return createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: (deps) => createChatRunner({ ...deps, authAdmission: admission }) }),
    sessionViewLoader: createSessionViewLoader({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store) }),
  })
}

/** The `withChat` of one test file: each chat runs in a temporary directory
 *  that the file owns. Call it once at the top level of the file, because it
 *  registers the file's cleanup hooks (`temporaryDirectories`). */
export function questionHoldChats() {
  const tmp = temporaryDirectories()
  return async function withChat(steps: readonly Step[], run: (chat: Chat) => Promise<void>): Promise<void> {
    const ctx = createSupervisorTestContext(tmp("flywheel-question-hold-"))
    const model = scriptedModel(steps)
    const chat: Chat = { ctx, writer: ctx.runtime.runSync(EventStoreWriterService), model, supervisor: newSupervisor(ctx, model), sessionId: "", conversationId: "" }
    try {
      chat.sessionId = await chat.supervisor.openSessionRuntime({ name: "Hold" })
      const session = await ctx.manager.read(chat.sessionId)
      chat.conversationId = session?.kind === "chat" ? session.conversationId : ""
      await run(chat)
    } finally {
      await chat.supervisor.disposeAll()
      await ctx.runtime.dispose()
    }
  }
}

export async function until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/** Lets a turn that a delivery could wrongly start reach the model. */
export async function quiesce(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Bun.sleep(5)
}

type DescribedMessage = { readonly kind: string; readonly content?: unknown; readonly toolUseId?: string; readonly interrupted?: boolean }

export function describeMessage(message: DescribedMessage): string {
  const { content } = message
  if (message.kind === "assistant") {
    if (!Array.isArray(content)) return `assistant(${String(content)})`
    return `assistant(${content.map((block: { type: string; name?: string; id?: string; text?: string }) => block.type === "tool_use" ? `call:${block.name}#${block.id}` : block.type === "text" ? block.text : block.type).join(",")})`
  }
  if (message.kind === "toolResult") return `toolResult#${message.toolUseId}${message.interrupted ? "[interrupted]" : ""}`
  return `${message.kind}(${typeof content === "string" ? content : JSON.stringify(content)})`
}

/** The branch from the ask to the leaf. */
export async function fromAsk(chat: Chat): Promise<string[]> {
  const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
  if (!tree) return []
  try {
    const entries = (await tree.getBranch()).map((entry) => entry.kind === "message" ? describeMessage(entry.message) : `<${entry.kind}>`)
    return entries.slice(Math.max(entries.findLastIndex((entry) => entry.includes("call:ask_user")), 0))
  } finally { tree.dispose() }
}

export async function heldCells(chat: Chat): Promise<number> {
  return (await asAsyncEventReadSurface(chat.ctx.store).readInFlight(chat.sessionId, [QUEUED_USER_INPUT_IN_FLIGHT_KIND, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND])).length
}

export async function pendingAsk(chat: Chat) {
  return (await loadAgentInputProjection(asAsyncEventReadSurface(chat.ctx.store), chat.sessionId)).get("ask-1")
}

export async function settle(chat: Chat, how: "answer" | "skip" = "answer") {
  const interaction = await pendingAsk(chat)
  const question = interaction?.request[0]
  const choice = question?.choices[0]
  if (!question || choice?.kind !== "option" || choice.choiceId === undefined) throw new Error("no pending question to settle")
  const { choiceId } = choice
  return how === "answer"
    ? chat.supervisor.answerQuestion(chat.sessionId, "ask-1", { [question.question]: { kind: "choice", selections: [{ choiceId }], text: choice.label } })
    : chat.supervisor.cancelQuestion(chat.sessionId, "ask-1")
}

/** Parks a question, stops the supervisor in order, and starts a successor,
 *  which leaves the chat at rest with its question waiting. */
export async function questionAtRest(chat: Chat, options: { readonly attach: boolean }): Promise<void> {
  expect(await chat.supervisor.sendChat(chat.sessionId, "Ask me something.")).toMatchObject({ ok: true })
  await until("the question to wait", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
  await chat.supervisor.disposeAll()
  chat.supervisor = newSupervisor(chat.ctx, chat.model)
  if (options.attach) await attach(chat)
}

export async function attach(chat: Chat): Promise<void> {
  expect(await chat.supervisor.activateSession(chat.sessionId, { shown: true })).toBe(true)
  await until("the runner to attach", () => Boolean(chat.ctx.sessionStore.get(chat.sessionId)?.runner))
  await quiesce()
}

/** Nothing landed after the ask and no request started. */
export async function expectHeld(chat: Chat, mark: number): Promise<void> {
  await quiesce()
  expect(await fromAsk(chat)).toEqual(["assistant(call:ask_user#ask-1)"])
  expect(chat.model.requests.length).toBe(mark)
}

/** The settlement continued one turn: ask, its result, the held input in
 *  arrival order, the reply. The one request carries the same order. */
export async function expectContinued(chat: Chat, mark: number, held: readonly string[]): Promise<void> {
  await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).length >= 3 + held.length)
  await quiesce()
  const branch = await fromAsk(chat)
  expect(branch).toHaveLength(3 + held.length)
  expect(branch[1]).toStartWith("toolResult#ask-1")
  for (const [index, text] of held.entries()) expect(branch[2 + index]).toContain(text)
  expect(branch.at(-1)).toStartWith("assistant(")
  expect(chat.model.requests.length).toBe(mark + 1)
  const request = chat.model.requests[mark]?.map(describeMessage) ?? []
  const resultIndex = request.findIndex((entry) => entry.startsWith("toolResult#ask-1"))
  expect(resultIndex).toBeGreaterThan(0)
  for (const [index, text] of held.entries()) expect(request[resultIndex + 1 + index]).toContain(text)
  expect(await heldCells(chat)).toBe(0)
}

/** The blocks from the question's row to the end. */
function fromQuestion(blocks: readonly AnyBlock[]): AnyBlock[] {
  return blocks.slice(Math.max(blocks.findLastIndex((block) => block.kind === "question"), 0))
}

/** A message row states whether it is queued, its id, and whether another
 *  session sent it; a divider states its label. */
function rows(blocks: readonly AnyBlock[]): string[] {
  return blocks.map((block) =>
    block.kind === "userMessage" ? `${block.pending ? "queued" : "sent"}#${block.id}(${block.from ? "from a session: " : ""}${block.content})`
      : block.kind === "text" ? `text(${block.content})` : block.kind === "divider" ? `divider(${block.label})` : block.kind)
}

/** The open display of the chat, from its question's row. */
export function displayedBlocks(chat: Chat): AnyBlock[] {
  return fromQuestion(chat.ctx.sessionStore.get(chat.sessionId)?.outputBlocks() ?? [])
}

/** What a fresh read of the stored transcript shows, from its question's row. */
export async function storedBlocks(chat: Chat): Promise<AnyBlock[]> {
  const projection = new SessionTranscriptProjection({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), executionCwd: chat.ctx.baseDir })
  try {
    const transcript = await projection.read()
    return fromQuestion(transcript ? await Promise.all(Array.from({ length: transcript.blockCount }, (_, index) => transcript.readBlock(index))) : [])
  } finally { await projection.dispose() }
}

export const displayedRows = (chat: Chat): string[] => rows(displayedBlocks(chat))
export const storedRows = async (chat: Chat): Promise<string[]> => rows(await storedBlocks(chat))

/** The question fact of the seeded call `ask-1`. */
export async function askedQuestion(chat: Chat): Promise<void> {
  await chat.ctx.store.append({
    aggregateId: `session:${chat.sessionId}`, sessionId: chat.sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
    payload: { interactionId: "ask-1", conversationId: chat.conversationId, toolUseId: "ask-1", request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }] },
  })
}

export const peerMessage = (chat: Chat, text: string, call: string) => deliverSessionInput({ manager: chat.ctx.manager, projectionReader: chat.ctx.runtime.runSync(EventReaderService), eventWriter: chat.writer }, chat.sessionId, {
  text,
  producer: { kind: "session", sessionId: "peer-session", conversationId: "peer-conversation", toolUseId: call, hop: 1, envelope: { name: "Peer", relation: "other", waits: false } },
})
