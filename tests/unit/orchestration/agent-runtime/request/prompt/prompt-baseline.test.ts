import { describe, expect, it } from "bun:test"

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../../src/infra/substrate/store/event-store-types.js"
import { createSqliteEventStore } from "../../../../../../src/infra/substrate/store/sqlite-event-store.js"
import type { ConversationMessage } from "../../../../../../src/infra/providers/llm/conversation/conversation-message.js"
import { createPromptBaseline, type PromptBaselineStore } from "../../../../../../src/orchestration/agent-runtime/request/prompt/prompt-baseline.js"
import type { SystemPromptPart } from "../../../../../../src/orchestration/agent-runtime/request/prompt/system-prompt.js"
import { conversationPromptBaselines } from "../../../../../../src/orchestration/session/conversation-records/conversation-prompt-baseline.js"
import { createSessionFactWriter } from "../../../../../../src/orchestration/session/persistence/session-fact-writer.js"
import { countStateRequests } from "../../../../../helpers/state-requests.js"

interface Inputs {
  readonly body?: string
  readonly skills: readonly (readonly [id: string, trigger: string])[]
  readonly agents: string
  readonly memory?: string
  readonly date: string
}

const OPENING: Inputs = { skills: [["review", "Review a diff"], ["plan", "Plan work"]], agents: "AGENTS V1", memory: "MEMORY V1", date: "2026-11-20" }

function partsOf(inputs: Inputs): SystemPromptPart[] {
  const skills = inputs.skills.map(([id, trigger]) => `- ${id}: ${trigger}`)
  return [
    { label: "chat body", text: inputs.body ?? "BODY", tier: "stable", change: "replace" },
    ...skills.length > 0 ? [{ label: "skill catalog", text: `Installed skills:\n${skills.join("\n")}`, tier: "stable" as const, change: "catalog" as const }] : [],
    { label: "AGENTS.md instructions", text: inputs.agents, tier: "stable", change: "replace" },
    ...inputs.memory === undefined ? [] : [{ label: "learning-memory", text: inputs.memory, tier: "session" as const, change: "replace" as const }],
    { label: "env", text: `<env>\nDate: ${inputs.date}\n</env>`, tier: "session", change: "hold" },
  ]
}

const person = (content: string): ConversationMessage => ({ kind: "user", content, origin: "human" })
const reply = (content: string): ConversationMessage => ({ kind: "assistant", content: [{ type: "text", text: content }] })

/** A conversation whose requests go through one run's fixed prompt: each request builds the prompt, then appends
 *  the entries that it is due, as the request preparation does. A compaction replaces the history, as the loop does. */
function conversation(store?: PromptBaselineStore, initial: ConversationMessage[] = []) {
  const baseline = createPromptBaseline(store, { sessionId: "s", conversationId: "c" })
  const chat = {
    history: initial,
    async request(inputs: Inputs, identity = "code+model+tools") {
      const tiers = await baseline.prompt(partsOf(inputs), identity, chat.history)
      const entries = baseline.updates(chat.history).map((entry) => ({ ...entry, origin: "system" as const }))
      chat.history.push(...entries)
      return { prompt: `${tiers.stable}|${tiers.session}|${tiers.conversation}`, entries: entries.map((entry) => String(entry.content)) }
    },
    compact(opening: string) {
      chat.history = [person(opening)]
      baseline.reset()
    },
  }
  return chat
}

const entry = (label: string, body: string): string => `<system-reminder prompt-part="${label}">\n${body}\n</system-reminder>`
const replaced = (label: string, text: string): string => entry(label, `This replaces the "${label}" part of your system prompt.\n\n${text}`)
const removed = (label: string): string => entry(label, `The "${label}" part of your system prompt no longer applies.`)
const restored = (label: string): string => entry(label, `The "${label}" part of your system prompt is current again. Earlier updates to it no longer apply.`)
const catalog = (...lines: string[]): string => entry("skill catalog", [`These entries of the "skill catalog" part of your system prompt changed. A "+" line is a new entry, a "~" line replaces the entry with its id, and a "-" line names an entry that was removed.`, ...lines].join("\n"))

/** A history that counts the messages that a walk over it visits. */
class VisitedHistory extends Array<ConversationMessage> {
  visits = 0
  override *[Symbol.iterator](): ArrayIterator<ConversationMessage> {
    for (let index = 0; index < this.length; index += 1) {
      this.visits += 1
      yield this[index]!
    }
  }
}

function memoryStore() {
  const events = createSqliteEventStore(":memory:")
  const writer = createSessionFactWriter({ sessionId: "s", writer: asAsyncEventWriter(events) })
  const counter = countStateRequests(asAsyncEventReadSurface(events))
  return { counter, store: () => conversationPromptBaselines(counter.reader, writer, { kind: "session", sessionId: "s" }, "c"), close: () => events.close() }
}

describe("a conversation's fixed system prompt", () => {
  it("keeps its bytes when skills, AGENTS.md, and memory change between person turns, and states each change once", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    const first = await chat.request(OPENING)
    chat.history.push(reply("done"), person("second"))
    const changed: Inputs = { ...OPENING, skills: [["plan", "Plan larger work"], ["ship", "Publish work"]], agents: "AGENTS V2", memory: "MEMORY V2" }
    const second = await chat.request(changed)
    const third = await chat.request(changed)

    expect(first.entries).toEqual([])
    expect(second.prompt).toBe(first.prompt)
    expect(second.entries).toEqual([
      catalog("~ plan: Plan larger work", "+ ship: Publish work", "- review"),
      replaced("AGENTS.md instructions", "AGENTS V2"),
      replaced("learning-memory", "MEMORY V2"),
    ])
    expect(third).toEqual({ prompt: first.prompt, entries: [] })
  })

  it("states a removed part, and that a part is current again when it returns to the prompt's text", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    await chat.request(OPENING)
    const withdrawn = await chat.request({ ...OPENING, memory: undefined })
    const back = await chat.request(OPENING)

    expect(withdrawn.entries).toEqual([removed("learning-memory")])
    expect(back.entries).toEqual([restored("learning-memory")])
  })

  it("states a change of a part that the code loads from an editable file, such as the body, without a render", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    const opening = await chat.request(OPENING)
    const edited = await chat.request({ ...OPENING, body: "BODY V2" })

    expect(edited).toEqual({ prompt: opening.prompt, entries: [replaced("chat body", "BODY V2")] })
  })

  it("withdraws what earlier entries stated when the part changes again, also across a render", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    await chat.request(OPENING)
    const withShip = await chat.request({ ...OPENING, skills: [...OPENING.skills, ["ship", "Publish work"]], memory: "MEMORY V2" })
    // The skill goes away while another one changes, and memory goes away with a switch to another model.
    const withoutShip = await chat.request({ ...OPENING, skills: [["review", "Review a diff"], ["plan", "Plan larger work"]], memory: "MEMORY V2" })
    const switched = await chat.request({ ...OPENING, skills: [["review", "Review a diff"], ["plan", "Plan larger work"]], memory: undefined }, "code+other-model+tools")
    const settled = await chat.request({ ...OPENING, skills: [["review", "Review a diff"], ["plan", "Plan larger work"]], memory: undefined }, "code+other-model+tools")

    expect(withShip.entries).toEqual([catalog("+ ship: Publish work"), replaced("learning-memory", "MEMORY V2")])
    expect(withoutShip.entries).toEqual([catalog("~ plan: Plan larger work", "- ship")])
    expect(switched.prompt).not.toContain("MEMORY")
    expect(switched.entries).toEqual([removed("learning-memory")])
    expect(settled.entries).toEqual([])
  })

  it("keeps the date on which the context opened, also across a render for another model on a later day", async () => {
    const chat = conversation()
    chat.history.push(person("before midnight"))
    const opening = await chat.request(OPENING)
    chat.history.push(reply("done"), person("after midnight"))
    const later = await chat.request({ ...OPENING, date: "2026-11-21" })
    const switched = await chat.request({ ...OPENING, date: "2026-11-21" }, "code+other-model+tools")

    expect(opening.prompt).toContain("Date: 2026-11-20")
    expect(later).toEqual({ prompt: opening.prompt, entries: [] })
    expect(switched.prompt).toContain("Date: 2026-11-20")
    expect(switched.prompt).not.toContain("Date: 2026-11-21")
    expect(switched.entries).toEqual([])
  })

  it("renders again for another code, model, or tool surface, and says that an earlier entry no longer applies", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    const opening = await chat.request(OPENING)
    const stated = await chat.request({ ...OPENING, agents: "AGENTS V2" })
    const switched = await chat.request({ ...OPENING, agents: "AGENTS V3" }, "code+other-model+tools")

    expect(stated.prompt).toBe(opening.prompt)
    expect(switched.prompt).toContain("AGENTS V3")
    expect(switched.prompt).not.toBe(opening.prompt)
    // The new prompt holds the change, so the entry that stated V2 no longer applies.
    expect(switched.entries).toEqual([restored("AGENTS.md instructions")])
  })

  it("renders a fresh context after each compaction with every change and the date it opens on, also when two openings are equal", async () => {
    const chat = conversation()
    chat.history.push(person("first"))
    await chat.request(OPENING)
    const changed = { ...OPENING, agents: "AGENTS V2", memory: "MEMORY V2" }
    expect((await chat.request(changed)).entries).toHaveLength(2)

    chat.compact("A fresh context window has started.")
    const fresh = await chat.request({ ...changed, date: "2026-11-21" })
    expect(fresh.prompt).toContain("AGENTS V2")
    expect(fresh.prompt).toContain("MEMORY V2")
    expect(fresh.prompt).toContain("Date: 2026-11-21")
    expect(fresh.entries).toEqual([])

    chat.compact("A fresh context window has started.")
    const again = await chat.request({ ...changed, agents: "AGENTS V3" })
    expect(again.prompt).toContain("AGENTS V3")
    expect(again.entries).toEqual([])
    expect(chat.history.some((message) => String(message.content).includes("prompt-part"))).toBe(false)
  })

  it("restores the recorded bytes after a restart and a resume, and states each change once across both runs", async () => {
    const { store, close } = memoryStore()
    try {
      const first = conversation(store())
      first.history.push(person("first"))
      const opening = await first.request(OPENING)
      first.history.push(reply("done"), person("second"))
      const stated = await first.request({ ...OPENING, agents: "AGENTS V2" })

      // A new run of the conversation resumes its history and reads the current inputs, which changed again.
      const resumed = conversation(store(), [...first.history, reply("done"), person("third")])
      const restarted = await resumed.request({ ...OPENING, agents: "AGENTS V2" })
      const later = await resumed.request({ ...OPENING, agents: "AGENTS V3" })

      expect(stated.entries).toHaveLength(1)
      expect(restarted).toEqual({ prompt: opening.prompt, entries: [] })
      expect(later).toEqual({ prompt: opening.prompt, entries: [replaced("AGENTS.md instructions", "AGENTS V3")] })

      // A run whose history holds a context that the recorded prompt is not fixed for renders its own.
      const compacted = conversation(store(), [person("A fresh context window has started.")])
      expect((await compacted.request({ ...OPENING, agents: "AGENTS V3" })).prompt).toContain("AGENTS V3")
    } finally {
      await close()
    }
  })

  it("reads its durable prompt once for a run, and its history once for each context, however long the history", async () => {
    const { counter, store, close } = memoryStore()
    try {
      const work = async (historyLength: number) => {
        const history = new VisitedHistory(...Array.from({ length: historyLength }, (_, index) => index % 2 === 0 ? person(`message ${index}`) : reply(`reply ${index}`)))
        const chat = conversation(store(), history)
        counter.take()
        const reads: number[] = []
        const visited: number[] = []
        for (const [agents, identity] of [["AGENTS V1", "a"], ["AGENTS V2", "a"], ["AGENTS V2", "b"], ["AGENTS V3", "b"]] as const) {
          history.visits = 0
          await chat.request({ ...OPENING, agents }, identity)
          reads.push(counter.take().length)
          visited.push(history.visits)
        }
        return { reads, visited }
      }

      const short = await work(3)
      const long = await work(301)
      expect(short.reads.slice(1)).toEqual([0, 0, 0])
      expect(long.reads).toEqual(short.reads)
      // Only the first request reads the history; later ones, the render for identity b included, read none of it.
      expect(long.visited[0]).toBeGreaterThanOrEqual(301)
      expect(long.visited.slice(1)).toEqual([0, 0, 0])
      expect(short.visited.slice(1)).toEqual([0, 0, 0])
    } finally {
      await close()
    }
  })

  it("reads the facts of an owner's conversations once, whatever their number", async () => {
    const work = async (conversations: number) => {
      const events = createSqliteEventStore(":memory:")
      try {
        const writer = createSessionFactWriter({ sessionId: "s", writer: asAsyncEventWriter(events) })
        const counter = countStateRequests(asAsyncEventReadSurface(events))
        const owner = { kind: "session" as const, sessionId: "s" }
        const of = (index: number) => conversationPromptBaselines(counter.reader, writer, owner, `c${index}`)
        const baseline = { opening: "opening", identity: "identity", parts: partsOf(OPENING) }
        for (let index = 0; index < conversations; index += 1) await of(index).record(baseline)
        await of(0).read()
        counter.take()
        await of(0).record({ ...baseline, identity: "another" })
        const reads = [await of(0).read(), await of(conversations - 1).read()]
        expect(reads.map((read) => read?.identity)).toEqual(["another", "identity"])
        return counter.take().map((request) => request.facts)
      } finally {
        await events.close()
      }
    }

    const few = await work(3)
    expect(await work(30)).toEqual(few)
    expect(few.reduce((total, facts) => total + facts, 0)).toBe(1)
  })
})
