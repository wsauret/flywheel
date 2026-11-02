import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../src/infra/paths"
import { createSqliteEventStore } from "../src/infra/sqlite-event-store"
import type { TurnEnd } from "../src/orchestration/session/conversation/turn-end-record"
import type { ChatRunner } from "../src/orchestration/chat/runner-types"
import { appendTurnEnd, createStoredChatSession } from "../tests/unit/orchestration/chat/_chat-session-agent-runtime-fixtures"
import { temporaryDirectories } from "../tests/helpers/directories"

const temporary = temporaryDirectories()
const stores: { close(): void }[] = []
let chat: ChatRunner | null = null
afterEach(async () => {
  await chat?.dispose()
  chat = null
  for (const store of stores.splice(0)) store.close()
})

function openStore() {
  const dir = temporary("parent-wake-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  stores.push(store)
  return { dir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) }
}

type Tree = Parameters<Parameters<typeof createStoredChatSession>[0]["seed"]>[0]

/** The parent's turn started a subagent in the background: the person asked,
 *  the model called `subagent`, and the dispatch returned its run id. */
async function seedDispatch(tree: Tree): Promise<void> {
  await tree.appendMessage({ kind: "user", content: "delegate the letter to a child", origin: "human" })
  await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "sub-1", name: "subagent", input: { prompt: "find the letter" } }] })
  await tree.appendMessage({ kind: "toolResult", toolUseId: "sub-1", content: [{ type: "text", text: "Started child-run-1 in the background." }] })
}

/** A parent's last turn: it started a subagent, then called a process wait on
 *  the running child, the wait's batch finished, and then `end` cut the turn. */
async function seedBackgroundWait(tree: Tree, end: TurnEnd): Promise<void> {
  await seedDispatch(tree)
  await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-1", name: "process", input: { action: "wait" } }] })
  await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-1", content: [{ type: "text", text: "The child still runs." }] })
  await appendTurnEnd(tree, end)
}

/** A parent's last turn: it started a subagent and answered the person, and
 *  no stop or crash cut the turn. */
async function seedAnsweredDispatch(tree: Tree): Promise<void> {
  await seedDispatch(tree)
  await tree.appendMessage({ kind: "assistant", content: "I started a subagent to find the letter. I will report when it finishes." })
}

const COMPLETION_TEXT = "The subagent finished: the letter is Q."
const QUIET_MS = 200

/** Opens the stored parent as a runner that attaches after a restart finds
 *  it, holds it as the child's resume does, and waits for the hold to
 *  settle. It then checks that no model request starts for about 200 ms
 *  before the child completes, and delivers the child's completion. */
async function attachedParent(seed: (tree: Tree) => Promise<void>) {
  const { dir, reader, writer } = openStore()
  const stored = await createStoredChatSession({ sessionId: "chat-stored", conversationId: "conversation-chat-stored", projectRoot: dir, reader, writer, seed })
  chat = stored.chat
  await stored.chat.hold()
  await stored.parked(1)
  await Bun.sleep(QUIET_MS)
  expect(stored.calls).toEqual([])
  await stored.chat.deliverBackgroundNotification({ key: "subagent-completions:child-run-1", completionRunIds: ["child-run-1"], text: COMPLETION_TEXT })
  return stored
}

const restartedParent = (end: TurnEnd) => attachedParent((tree) => seedBackgroundWait(tree, end))

const carriesCompletion = (calls: readonly unknown[]) => calls.some((context) => JSON.stringify(context).includes(COMPLETION_TEXT))

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(5)
}

const cuts = [
  ["the runtime stopped the service", { reason: "paused", pausedBy: "runtime" }],
  ["the service crashed", { reason: "crash" }],
  ["an update replaced the service", { reason: "paused", pausedBy: "runtime", planned: true }],
] as const satisfies readonly (readonly [string, TurnEnd])[]

describe("a parent that waited on its child when its service stopped", () => {
  for (const [label, end] of cuts) {
    test(`after ${label}, the parent starts no model request before the child completes, and the completion starts one that reads it`, async () => {
      const stored = await restartedParent(end)
      await until(() => carriesCompletion(stored.calls), 3000)
      expect(stored.calls.length).toBeGreaterThan(0)
      expect(carriesCompletion(stored.calls)).toBe(true)
    })
  }

  // Regression guard: this passes before the fix and must keep passing.
  test("regression guard: after the person interrupted the wait, the child's completion starts no model request and the chat stays interrupted", async () => {
    const stored = await restartedParent({ reason: "paused", pausedBy: "person" })
    await until(() => stored.calls.length > 0, 400)
    expect(stored.calls).toEqual([])
    expect(await stored.chat.messageState()).toBe("interrupted")
  })

  // Regression guard: this passes before the fix and must keep passing.
  test("regression guard: a parent that answered after it started its child, with no stop or crash, wakes when the child completes", async () => {
    const stored = await attachedParent(seedAnsweredDispatch)
    await until(() => carriesCompletion(stored.calls), 3000)
    expect(carriesCompletion(stored.calls)).toBe(true)
  })
})
