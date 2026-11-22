/**
 * Chat trees on the Google Antigravity route (plan M13, ARCH-PROVIDERS-086): every agent of one tree on one login is a
 * session of one `agy acp` process, whatever its prompt and grant; a failure of one agent's request fails only that
 * agent; a process that dies fails the streams that were open on it, and the next attempt of each agent rotates to a
 * new process from canonical history (the counterpart of ARCH-PROVIDERS-071); and two trees on one login run in
 * parallel without either reading the other's traffic. Each agent runs through the real provider client against the
 * real pinned engine and the fake Gemini host.
 */
import { describe, expect, test } from "bun:test"
import { LlmStreamError, RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import type { ConversationMessage, ToolDef } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { engineCall, openClientRig, result, send, sendFailing, user, type Agent, type ClientRig } from "./_client.js"
import { eventually, expectNoEngineLeft, openEngineHarness, type EngineHarness, type HarnessLogin } from "./_engine.js"
import type { FakeRequest } from "./_fake-gemini.js"

const temporary = temporaryDirectories()
expectNoEngineLeft()

const tool = (name: string): ToolDef => ({ name, description: `The ${name} tool.`, input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })
const [ECHO, READ] = [tool("echo"), tool("read")]
const TIMEOUT_MS = 120_000

/** One agent with its own prompt, grant, and history. */
interface Member {
  readonly name: string
  readonly agent: Agent
  readonly tools: readonly ToolDef[]
  readonly history: ConversationMessage[]
}

const promptOf = (name: string) => `${name.toUpperCase()}-PROMPT`
const systemOf = (name: string) => ({ stable: "STABLE-TIER", session: promptOf(name), conversation: "" })

/** Sends the member's next request on its history and records the answer, as the agent loop does. */
async function step(member: Member) {
  const sent = await send(member.agent.client, { messages: member.history, tools: member.tools, systemPrompt: systemOf(member.name) })
  member.history.push(sent.assistant)
  return sent
}

/** Runs one turn of the member: each call's result is `RESULT <name> <text>`, until the model answers. */
async function turn(member: Member, words: string): Promise<readonly string[]> {
  member.history.push(user(words))
  const calls: string[] = []
  for (;;) {
    const sent = await step(member)
    if (sent.calls.length === 0) return calls
    for (const call of sent.calls) {
      calls.push(String(call.input.text))
      member.history.push(result(call.id, `RESULT ${member.name} ${String(call.input.text)}`))
    }
  }
}

/** The members' prompts that a request carries. */
function promptsIn(request: FakeRequest, names: readonly string[]): string[] {
  return names.filter((name) => request.body.includes(promptOf(name)))
}

interface TreeRun {
  readonly harness: EngineHarness
  readonly login: HarnessLogin
  readonly rig: ClientRig
  member(tree: string, name: string, tools: readonly ToolDef[]): Promise<Member>
}

async function withTrees(use: (run: TreeRun) => Promise<void>): Promise<void> {
  const root = temporary("agt-")
  const harness = openEngineHarness(root)
  try {
    const login = await harness.login("w")
    const rig = openClientRig([login])
    try {
      await use({
        harness, login, rig,
        async member(tree, name, tools) {
          return { name, tools, history: [], agent: await rig.agent({ login, tree, session: name, projectRoot: root }) }
        },
      })
    } finally {
      await rig.close()
    }
  } finally {
    await harness.close()
  }
}

/** The processes that served `tree`, without the tool-less process of each gate probe. */
const servedTree = (rig: ClientRig, tree: string) => rig.launched.filter(({ place }) => place.treeRootSessionId === tree)

describe("Google Antigravity chat trees", () => {
  test("a parent and two children with their own prompts and grants share one process, and a child's 503 fails only that child", async () => {
    await withTrees(async ({ harness, login, rig, member }) => {
      const parent = await member("tree", "parent", [ECHO, READ])
      await turn(parent, "start")
      const [childA, childB] = [await member("tree", "child-a", [ECHO]), await member("tree", "child-b", [READ])]
      harness.fake.script([
        { kind: "calls", when: promptOf("child-a"), calls: [engineCall("from-a")] },
        { kind: "text", when: "RESULT child-a from-a", text: "child a done" },
        { kind: "status", status: 503, when: promptOf("child-b") },
      ])
      const [parentCalls, childACalls, childBFailure] = await Promise.all([
        turn(parent, "parent again"),
        turn(childA, "child a task"),
        (async () => {
          childB.history.push(user("child b task"))
          return sendFailing(childB.agent.client, { messages: childB.history, tools: childB.tools, systemPrompt: systemOf(childB.name) })
        })(),
      ])
      expect(parentCalls).toEqual([])
      expect(childACalls).toEqual(["from-a"])
      expect(childBFailure.error).toBeInstanceOf(LlmStreamError)
      expect(childBFailure.error).toMatchObject({ kind: "overload" })
      // The walk retries the child's request, and only that child rotates to a new session of the same process.
      expect((await step(childB)).stopReason).toBe("end_turn")

      expect(servedTree(rig, "tree")).toHaveLength(1)
      expect(await harness.engineProcesses(login.loginDir)).toHaveLength(1)
      // Every main request carries one member's prompt, and the process declares the tree's tools to each of them.
      const names = [parent.name, childA.name, childB.name]
      const mains = harness.fake.requests.filter((request) => request.kind === "main")
      expect(mains.every((request) => promptsIn(request, names).length === 1)).toBe(true)
      expect(new Set(mains.map((request) => promptsIn(request, names)[0]))).toEqual(new Set(names))
      expect(mains.every((request) => request.body.includes("mcp_runtime_echo") && request.body.includes("mcp_runtime_read"))).toBe(true)
    })
  }, TIMEOUT_MS)

  test("a killed process fails the streams open on it, and each agent's next attempt rotates to a new process from canonical history", async () => {
    await withTrees(async ({ harness, rig, member }) => {
      const members = [await member("tree", "parent", [ECHO]), await member("tree", "child", [ECHO])]
      harness.fake.script(members.map((each) => ({ kind: "calls", when: `${each.name} first`, calls: [engineCall(`${each.name}-x`)] }) as const))
      for (const each of members) expect(await turn(each, `HISTORY-MARKER ${each.name} first`)).toEqual([`${each.name}-x`])
      const [served] = servedTree(rig, "tree")
      expect(served).toBeDefined()

      // Each agent's next request waits at the host until the process dies.
      harness.fake.script(members.map((each) => ({ kind: "text", when: `${each.name} held`, text: "never", delayMs: 600_000 }) as const))
      const open = members.map((each) => {
        each.history.push(user(`${each.name} held`))
        return sendFailing(each.agent.client, { messages: each.history, tools: each.tools, systemPrompt: systemOf(each.name) })
      })
      const arrived = () => members.every((each) => harness.fake.requests.some((request) => request.kind === "main" && request.body.includes(`${each.name} held`)))
      expect(await eventually(arrived, 30_000)).toBe(true)
      await harness.killEngine(served!.engine.processId)
      const failures = await Promise.all(open)
      // No model frame of either request had arrived, so each fails as a route that could not serve it, and the walk
      // moves on with a typed failure, never with the closed connection.
      for (const failure of failures) expect(failure.error).toBeInstanceOf(RouteUnavailableError)
      expect(await served!.engine.ended).toMatchObject({ served: true })

      const mark = harness.fake.requests.length
      for (const each of members) expect((await step(each)).stopReason).toBe("end_turn")
      const relaunched = servedTree(rig, "tree")
      expect(relaunched).toHaveLength(2)
      expect(relaunched[1]!.engine.processId).not.toBe(served!.engine.processId)
      // Each new session opens with the agent's whole canonical history in its append: its first turn, the call, and the result.
      const mains = harness.fake.requests.slice(mark).filter((request) => request.kind === "main")
      expect(mains).toHaveLength(2)
      for (const each of members) {
        const own = mains.filter((request) => request.body.includes(promptOf(each.name)))
        expect(own).toHaveLength(1)
        expect([`HISTORY-MARKER ${each.name} first`, `RESULT ${each.name} ${each.name}-x`, `${each.name} held`].every((text) => own[0]!.body.includes(text))).toBe(true)
      }
      expect(harness.fake.requests.slice(mark).filter((request) => request.kind === "title").length).toBeGreaterThanOrEqual(2)
    })
  }, TIMEOUT_MS)

  test("two trees on one login run in parallel on their own processes without cross-talk", async () => {
    await withTrees(async ({ harness, login, rig, member }) => {
      const [one, two] = [await member("tree-one", "one", [ECHO]), await member("tree-two", "two", [ECHO])]
      // Each tree's first model request waits at the host until the other tree's has arrived, so the trees' turns
      // run at the same time, or the meeting fails both turns.
      harness.fake.script([[one, two], [two, one]].flatMap(([each, other]) => [
        { kind: "calls", when: `${each!.name} task`, meets: `${other!.name} task`, calls: [engineCall(`${each!.name}-1`), engineCall(`${each!.name}-2`)] } as const,
        { kind: "text", when: `RESULT ${each!.name} ${each!.name}-2`, text: `${each!.name} done` } as const,
      ]))
      const calls = await Promise.all([turn(one, "one task"), turn(two, "two task")])
      expect(calls).toEqual([["one-1", "one-2"], ["two-1", "two-2"]])
      expect([servedTree(rig, "tree-one"), servedTree(rig, "tree-two")].map((launched) => launched.length)).toEqual([1, 1])
      expect(servedTree(rig, "tree-one")[0]!.engine.processId).not.toBe(servedTree(rig, "tree-two")[0]!.engine.processId)
      expect(await harness.engineProcesses(login.loginDir)).toHaveLength(2)
      const mains = harness.fake.requests.filter((request) => request.kind === "main")
      expect(mains.map((request) => promptsIn(request, ["one", "two"]).length)).toEqual(mains.map(() => 1))
      for (const each of [one, two]) {
        const other = each === one ? "two" : "one"
        expect(mains.filter((request) => request.body.includes(promptOf(each.name))).some((request) => request.body.includes(`RESULT ${other}`))).toBe(false)
        expect(each.history.at(-1)).toMatchObject({ content: [{ type: "text", text: `${each.name} done` }] })
      }
    })
  }, TIMEOUT_MS)
})
