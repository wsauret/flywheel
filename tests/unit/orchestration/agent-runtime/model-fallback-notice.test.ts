import { expect, test } from "bun:test"
import { createModelFallbackNotice, type RequestServingSelection } from "../../../../src/orchestration/agent-runtime/model-fallback-notice.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import type { CommittedTree } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { createConversationMessageEntry } from "../../../../src/orchestration/session/conversation/conversation-tree.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

const FALLBACK = "The saved model, lost-model, cannot serve now. gpt-6-luna at high effort serves this agent until it can."
const RECOVERY = "The saved model, lost-model, serves this agent."

/** A conversation of `history` committed messages whose appends commit at once, so a new runtime reads them.
 *  `failures` names store calls that reject once, in order. */
function conversation(history: number, failures: Array<"read" | "append"> = []) {
  const entriesById: { [id: string]: ConversationEntry } = {}
  for (let index = 0; index < history; index += 1) {
    entriesById[`m${index}`] = createConversationMessageEntry({ kind: "user", content: `turn ${index}` }, `m${index}`, index === 0 ? null : `m${index - 1}`, "2026-10-27T00:00:00.000Z")
  }
  const appended: Array<{ readonly id: string; readonly message: ConversationMessage }> = []
  const shown: string[] = []
  const tree: CommittedTree = { leafId: history === 0 ? null : `m${history - 1}`, entriesById }
  const fails = (call: "read" | "append") => {
    if (failures[0] !== call) return
    failures.shift()
    throw new Error(`${call} failed`)
  }
  const counter = countStateRequests({ committedTree: async () => { fails("read"); return tree } })
  const runtime = () => {
    const record = createModelFallbackNotice({
      sessionId: "session", aggregateId: "conversation",
      persistence: {
        committedTree: counter.reader.committedTree,
        history: {
          append: async (message, id = "") => {
            fails("append")
            appended.push({ id, message })
            entriesById[id] = createConversationMessageEntry(message, id, null, "2026-10-27T00:00:00.000Z")
          },
        },
      },
    }, (message) => { shown.push(message) })
    if (!record) throw new Error("A durable conversation records fallback notices")
    return record
  }
  return { runtime, appended, shown, counter }
}

const saved = (model: string, effort = "high"): RequestServingSelection => ({ saved: "lost-model", model, effort })

test("records one display-only row when a request falls back, when the serving pair changes, and when the saved model serves again", async () => {
  const { runtime, appended, shown } = conversation(3)
  const record = runtime()
  await record({ saved: undefined, model: "gpt-6-luna", effort: "high" })
  await record({ saved: "gpt-6-luna", model: "gpt-6-luna", effort: "high" })
  expect(appended).toEqual([])
  await record(saved("gpt-6-luna"))
  await record(saved("gpt-6-luna"))
  await record(saved("gpt-6-luna", "low"))
  await record(saved("claude-haiku-4.5"))
  await record({ saved: "lost-model", model: "lost-model", effort: "high" })
  await record({ saved: "lost-model", model: "lost-model", effort: "high" })
  expect(appended).toEqual([
    { id: "model-fallback:conversation:0", message: { kind: "system", content: FALLBACK, displayOnly: true } },
    { id: "model-fallback:conversation:1", message: { kind: "system", content: "The saved model, lost-model, cannot serve now. gpt-6-luna at low effort serves this agent until it can.", displayOnly: true } },
    { id: "model-fallback:conversation:2", message: { kind: "system", content: "The saved model, lost-model, cannot serve now. claude-haiku-4.5 at high effort serves this agent until it can.", displayOnly: true } },
    { id: "model-fallback:conversation:3", message: { kind: "system", content: RECOVERY, displayOnly: true } },
  ])
  expect(shown).toEqual(appended.map(({ message }) => message.kind === "system" ? message.content : ""))
})

test("continues from the newest row that an earlier runtime recorded", async () => {
  const { runtime, appended } = conversation(3)
  await runtime()(saved("gpt-6-luna"))
  await runtime()(saved("gpt-6-luna"))
  expect(appended.map(({ id }) => id)).toEqual(["model-fallback:conversation:0"])
  await runtime()({ saved: "lost-model", model: "lost-model", effort: "high" })
  await runtime()(saved("gpt-6-luna"))
  expect(appended.map(({ id, message }) => [id, message.kind === "system" ? message.content : ""])).toEqual([
    ["model-fallback:conversation:0", FALLBACK],
    ["model-fallback:conversation:1", RECOVERY],
    ["model-fallback:conversation:2", FALLBACK],
  ])
})

test("a request reads the committed tree only when its runtime starts, however long the history", async () => {
  for (const history of [3, 3_000]) {
    const { runtime, counter } = conversation(history)
    const record = runtime()
    for (let request = 0; request < 20; request += 1) await record(saved(request % 5 === 0 ? "claude-haiku-4.5" : "gpt-6-luna"))
    expect(counter.take().map(({ method }) => method)).toEqual(["committedTree"])
  }
})

test("a setting that names no concrete model ends the condition with the model that serves, and claims no recovery", async () => {
  const { runtime, appended } = conversation(3)
  const record = runtime()
  await record(saved("gpt-6-luna"))
  await record({ saved: undefined, model: "gpt-6-luna", effort: "high" })
  await record({ saved: "powerful", model: "gpt-6-luna", effort: "high" })
  await record({ saved: "gpt-6-luna", model: "gpt-6-luna", effort: "high" })
  await record({ saved: "other-lost-model", model: "gpt-6-luna", effort: "high" })
  expect(appended.map(({ message }) => message.kind === "system" ? message.content : "")).toEqual([
    FALLBACK,
    "gpt-6-luna at high effort serves this agent.",
    "The saved model, other-lost-model, cannot serve now. gpt-6-luna at high effort serves this agent until it can.",
  ])
})

test("a newly saved model that serves ends the condition by its own name, and claims no recovery of the earlier one", async () => {
  const { runtime, appended } = conversation(3)
  const record = runtime()
  await record(saved("gpt-6-luna"))
  await record({ saved: "gpt-6-astra", model: "gpt-6-astra", effort: "high" })
  expect(appended.map(({ message }) => message.kind === "system" ? message.content : "")).toEqual([
    FALLBACK,
    "The saved model, gpt-6-astra, serves this agent.",
  ])
})

test("a failed read or append never fails the request, and the next request records the row", async () => {
  for (const failure of ["read", "append"] as const) {
    const { runtime, appended } = conversation(3, [failure])
    const record = runtime()
    await record(saved("gpt-6-luna"))
    expect(appended).toEqual([])
    await record(saved("gpt-6-luna"))
    await record(saved("gpt-6-luna"))
    expect(appended.map(({ id, message }) => [id, message.kind === "system" ? message.content : ""])).toEqual([["model-fallback:conversation:0", FALLBACK]])
  }
})
