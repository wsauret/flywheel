import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { MessageEntrySchema } from "../../../../src/orchestration/session/conversation/conversation-entry-schemas.js"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff"
import { buildMutationDiffEntries } from "../../../../src/infra/mutation-diff-evidence"
import { buildMutationEvidence, readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence"
import { readSessionContentRange } from "../../../../src/infra/session-content"
import { sessionContentFixture } from "../../../helpers/session-content"
import type { ConversationEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { DELIVERY_CONFIRMATION } from "../../../../src/infra/delivery-confirmation.js"
import { AnyBlockSchema } from "../../../../src/infra/output-blocks.js"
import { projectBlocksFromEntries, TreeBlockProjection } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import { projectFrontendOutputBlocks } from "../../../../src/orchestration/app-service/frontend-output-blocks"

const CWD = resolve("/scratch/project")
const T0 = "2026-07-02T10:00:00.000Z"

let seq = 0
function entry(message: MessageEntry["message"], overrides: Partial<MessageEntry> = {}): MessageEntry {
  seq += 1
  return { id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp: T0, kind: "message", message, ...overrides }
}

function project(entries: ConversationEntry[]) {
  return projectBlocksFromEntries(entries, { executionCwd: CWD })
}

describe("tree -> output blocks re-projection", () => {
  it("reopens a memory refusal with a curated error rather than its JSON recovery data", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "memory-overflow", name: "memory", input: { action: "add", title: "Save preference", content: "Prefers terse replies." } }],
    })
    const result = entry({
      kind: "toolResult",
      toolUseId: "memory-overflow",
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "Memory at 1,409/1,500 chars. Adding this entry (159 chars) would exceed the limit by 68 chars.", current_entries: ["Private memory."] }) }],
    })
    const [block] = project([assistant, result])
    if (block?.kind !== "tool" || block.status !== "error") throw new Error("expected failed memory tool")
    expect(block.errorMessage).toBe("Memory update exceeds the limit by 68 characters")
  })

  it("reopens public thinking as text without changing signed history", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const assistant = entry({ kind: "assistant", content: [
      { type: "thinking", thinking: "private reasoning", signature: "EgwKCkIIdGhpbmtpbmc=" },
      { type: "thinking", thinking: `Found the cause. ${secret}`, signature: "progress-signature", presentation: "progress" },
      { type: "thinking", thinking: "The checks passed.", signature: "Eg0KC0IJbmFycmF0aW9u" },
      { type: "tool_use", id: "progress-tool", name: "read", input: { path: "test.ts" } },
    ] });
    const restored = Schema.decodeUnknownSync(MessageEntrySchema)(JSON.parse(JSON.stringify(assistant)));
    const original = structuredClone(restored.message);
    const blocks = project([restored]);
    expect(blocks[0]).toMatchObject({ kind: "thinking", id: `${assistant.id}:0`, content: "private reasoning", status: "completed" });
    expect(blocks[1]).toMatchObject({ kind: "text", id: `${assistant.id}:1`, content: "Found the cause. [redacted secret]" });
    expect(blocks[2]).toMatchObject({ kind: "text", id: `${assistant.id}:2`, content: "The checks passed." });
    expect(restored.message).toEqual(original);
    expect(restored.message).toMatchObject({ content: expect.arrayContaining([
      expect.objectContaining({ type: "thinking", thinking: `Found the cause. ${secret}`, signature: "progress-signature" }),
    ]) });
    expect(JSON.stringify(blocks)).not.toContain("signature");
  });

  it("projects a plain user/assistant turn", () => {
    const user = entry({ kind: "user", content: "hello", submissionIds: ["hello-1", "hello-2"] })
    const assistant = entry({ kind: "assistant", content: "hi there" })
    const blocks = project([user, assistant])

    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "hello", timestamp: Date.parse(T0), pending: false, injected: false, submissionIds: ["hello-1", "hello-2"] },
      { kind: "text", id: assistant.id, content: "hi there", timestamp: Date.parse(T0) },
    ])
  })

  it("uses the incremental fold for batch projection without mutating earlier snapshots", () => {
    const first = entry({ kind: "assistant", content: "hello " })
    const second = entry({ kind: "assistant", content: "world" })
    const projection = new TreeBlockProjection({ executionCwd: CWD })
    projection.add(first)
    const beforeSeam = projection.snapshot()
    projection.add(second)

    expect(projection.snapshot()).toEqual(projectBlocksFromEntries([first, second], { executionCwd: CWD }))
    expect(projection.snapshot()).toEqual([
      { kind: "text", id: first.id, content: "hello ", timestamp: Date.parse(T0) },
      { kind: "text", id: second.id, content: "world", timestamp: Date.parse(T0) },
    ])
    expect(beforeSeam).toEqual([
      { kind: "text", id: first.id, content: "hello ", timestamp: Date.parse(T0) },
    ])
  })

  it("skips system-origin user entries (runtime notification envelopes are hidden from the transcript)", () => {
    const user = entry({ kind: "user", content: "real question" })
    const reply = entry({ kind: "assistant", content: [{ type: "text", text: "NUMBER=7" }] })
    const injected = entry({ kind: "user", content: "<subagent_notifications>\n<visibility>hidden_from_user</visibility>\n</subagent_notifications>", origin: "system" })
    const assistant = entry({ kind: "assistant", content: [{ type: "text", text: "NUMBER=7" }] })
    const blocks = project([user, reply, injected, assistant])

    // The hidden envelope leaves two replies adjacent; each stays its own row, as it was live.
    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "real question", timestamp: Date.parse(T0), pending: false, injected: false },
      { kind: "text", id: `${reply.id}:0`, content: "NUMBER=7", timestamp: Date.parse(T0) },
      { kind: "text", id: `${assistant.id}:0`, content: "NUMBER=7", timestamp: Date.parse(T0) },
    ])
  })

  it("renders a message from another session as a row that names its sender and the words of the person", () => {
    const envelope = { name: "Parser fix", relation: "child" as const, waits: false, personWords: "use the old one" }
    const message = entry({ kind: "user", content: "Which parser?", producer: { kind: "session", sessionId: "child-1", conversationId: "child-conversation", toolUseId: "call-1", hop: 0, envelope } })
    expect(project([message])).toEqual([{
      kind: "userMessage", id: message.id, content: "Which parser?", timestamp: Date.parse(T0), pending: false, injected: false,
      from: { sessionId: "child-1", name: "Parser fix", relation: "child", personWords: "use the old one" },
    }])
  })

  it("renders the assignment that launched a subagent as a row from its parent, not from the person", () => {
    const message = entry({ kind: "user", content: "Inspect the parser", producer: { kind: "launch", sessionId: "parent-1", toolUseId: "call-launch", name: "Root" } })
    expect(project([message])).toMatchObject([{ kind: "userMessage", content: "Inspect the parser", from: { sessionId: "parent-1", name: "Root", relation: "parent" } }])
  })

  it("renders an invocation user entry as a step boundary plus the raw args, hiding the expanded prompt", () => {
    const invocation = entry({ kind: "user", content: "Step \"Adapt\" is now active.\n<step ...>expanded body</step>", invocation: { label: "Adapt", args: "please adapt this box" }, submissionIds: ["adapt-1"] })
    const assistant = entry({ kind: "assistant", content: "done" })
    const blocks = project([invocation, assistant])

    expect(blocks).toEqual([
      { kind: "divider", id: `${invocation.id}:boundary`, label: "Adapt", timestamp: Date.parse(T0) },
      { kind: "userMessage", id: invocation.id, content: "please adapt this box", timestamp: Date.parse(T0), pending: false, injected: false, submissionIds: ["adapt-1"] },
      { kind: "text", id: assistant.id, content: "done", timestamp: Date.parse(T0) },
    ])
  })

  it("renders an argument-less invocation as only its step boundary", () => {
    const invocation = entry({ kind: "user", content: "expanded body", invocation: { label: "Code Review" } })
    const blocks = project([invocation])

    expect(blocks).toEqual([
      { kind: "divider", id: `${invocation.id}:boundary`, label: "Code Review", timestamp: Date.parse(T0) },
    ])
  })

  it("carries the tool's action, so a reopened read folds and abbreviates like a live one", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_read", name: "read", input: { path: "src/orchestration/agent-runtime/agent-loop.ts" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_read", content: [{ type: "text", text: "export const loop = 1" }] })
    const [tool] = project([assistant, result])
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.action).toBe("file_read")
    expect(tool.linkUri).toBe(pathToFileURL(resolve(CWD, "src/orchestration/agent-runtime/agent-loop.ts")).href)
  })

  it("settles tool_use parts against their toolResult entries", () => {
    const user = entry({ kind: "user", content: "run it" })
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "text", text: "Running." },
        { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo ok" } },
      ],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_1", content: [{ type: "text", text: "ok" }] })
    const blocks = project([user, assistant, result])

    expect(blocks).toHaveLength(3)
    const tool = blocks[2]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.id).toBe("toolu_1")
    expect(tool.name).toBe("bash")
    expect(tool.status).toBe("completed")
    expect(tool.presentation.detail).toContain("echo ok")
  })

  it("keeps a deferred workflow acknowledgement pending until its durable terminal result, and its card keeps the fold of its plan and the workflow's name", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "workflow-1", name: "workflow", input: { workflow_definition_id: "implement", description: "Do it" } }],
    })
    const acknowledgement = entry({
      kind: "toolResult",
      toolUseId: "workflow-1",
      content: [{ type: "text", text: "Workflow started; the terminal result will update this row." }],
    })

    const pending = projectBlocksFromEntries([assistant, acknowledgement], { executionCwd: CWD, toolResultMeta: new Map() })[0]
    const card = { done: 6, total: 6, failed: 0, finishedFailed: 0, running: 0, parked: 0, coverage: [{ text: "coverage required 2 of 3, 1 unsurveyed", tone: "failed" as const }], before: 0, after: 0, phases: [] }
    const completed = projectBlocksFromEntries([assistant, acknowledgement], {
      executionCwd: CWD,
      toolResultMeta: new Map([["workflow-1", { terminalOutcome: "ok", displayContent: "Workflow completed." }]]),
      toolSummaries: new Map([["workflow-1", { toolUseId: "workflow-1", status: "completed", ownsSettlement: false, totalToolCount: 6, label: "Fanout Ui", card }]]),
    })[0]
    const failed = projectBlocksFromEntries([assistant, acknowledgement], {
      executionCwd: CWD,
      toolResultMeta: new Map([["workflow-1", { terminalOutcome: "error", displayContent: "Review failed." }]]),
    })[0]

    // Before its terminal result, the card reads the workflow's own state.
    const interrupted = projectBlocksFromEntries([assistant, acknowledgement], {
      executionCwd: CWD,
      toolResultMeta: new Map(),
      toolSummaries: new Map([["workflow-1", { toolUseId: "workflow-1", status: "paused", pausedBy: "runtime", ownsSettlement: false, totalToolCount: 3, duration: 4000, linkUri: "flywheel://session/workflow-child" }]]),
    })[0]

    expect(pending).toMatchObject({ kind: "agentGroup", containerKind: "workflow", status: "pending" })
    expect(pending).not.toHaveProperty("duration")
    expect(interrupted).toMatchObject({ kind: "agentGroup", status: "paused", pausedBy: "runtime", duration: 4000 })
    expect(completed).toMatchObject({ kind: "agentGroup", status: "completed", totalToolCount: 6, label: "Fanout Ui", card })
    expect(interrupted).not.toHaveProperty("card")
    expect(failed).toMatchObject({ kind: "agentGroup", status: "error", failure: expect.objectContaining({ message: "Review failed" }) })
  })

  it("drops the delivery receipt from a settled tool body: it is turn metadata, not tool output", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "text", text: "Reply the user saw." },
        { type: "tool_use", id: "toolu_r", name: "bash", input: { command: "bun run lint" } },
      ],
    })
    const result = entry({
      kind: "toolResult",
      toolUseId: "toolu_r",
      content: [
        { type: "text", text: "lint passed" },
        { type: "text", text: DELIVERY_CONFIRMATION },
      ],
    })
    const blocks = project([assistant, result])
    const tool = blocks.find((block) => block.kind === "tool")
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.content).toBe("lint passed")
  })

  it("keeps background management calls in history but out of the transcript", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "background_1", name: "background", input: { action: "list" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "background_1", content: [{ type: "text", text: "Active background tasks" }] })

    expect(project([assistant, result])).toEqual([])
  })

  it("reconstructs current process management calls as hidden", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "process_1", name: "process", input: { action: "status", process_id: "task-1" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "process_1", content: [{ type: "text", text: "task-1 | completed" }] })

    expect(project([assistant, result])).toEqual([])
  })

  it("settles a blocked (gate) toolResult as a blocked row and appends an injected system message with the full text", () => {
    const message = "handoff blocked: owned background work is still running or its result has not been incorporated.\nStill running: verifier. End your turn and wait for it or stop it before handoff."
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_h", name: "handoff", input: { summary: "draft" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_h", content: [{ type: "text", text: message }], isError: true, blocked: true })
    const blocks = project([assistant, result])

    expect(blocks).toHaveLength(2)
    const tool = blocks[0]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    if (tool.status !== "blocked") throw new Error(`expected blocked status, got ${tool.status}`)
    expect(tool.statusMessage).toBe("handoff blocked: owned background work is still running or its result has not been incorporated.")
    const notice = blocks[1]
    if (notice?.kind !== "userMessage") throw new Error("expected injected user message")
    expect(notice.injected).toBe(true)
    expect(notice.content).toBe(message)
    expect(notice.id).toBe(`${result.id}:blocked`)
  })

  it("replays a failed bash exit code from the recorded result meta", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_bash_failure", name: "bash", input: { command: "printf 'stdout\\n'; printf 'stderr\\n' >&2; exit 47" } }],
    })
    const result = entry({
      kind: "toolResult",
      toolUseId: "toolu_bash_failure",
      content: [{ type: "text", text: "stdout\nstderr\n[exit code: 47]" }],
    })

    const blocks = projectFrontendOutputBlocks(projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_bash_failure", { exitCode: 47 }]]),
    }))

    expect(blocks[0]).toMatchObject({
      kind: "tool",
      id: "toolu_bash_failure",
      name: "bash",
      status: "completed",
      exitCode: 47,
    })
  })

  it("prefers recorded execution output for successful bash and falls back for old sessions", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "new-bash", name: "bash", input: { command: "new" } },
        { type: "tool_use", id: "old-bash", name: "bash", input: { command: "old" } },
      ],
    })
    const newResult = entry({ kind: "toolResult", toolUseId: "new-bash", content: [{ type: "text", text: "compressed new" }] })
    const oldResult = entry({ kind: "toolResult", toolUseId: "old-bash", content: [{ type: "text", text: "compressed old" }] })
    const blocks = projectBlocksFromEntries([assistant, newResult, oldResult], {
      executionCwd: CWD,
      toolResultMeta: new Map([["new-bash", { executionOutput: "durable new tail" }]]),
    })

    expect(blocks.filter((block) => block.kind === "tool").map((tool) => tool.content)).toEqual([
      "durable new tail",
      "compressed old",
    ])
  })

  it("replays background shell rows without management text and restores recorded command output", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "empty-background", name: "bash", input: { command: "sleep 1" } },
        { type: "tool_use", id: "output-background", name: "bash", input: { command: "echo ready" } },
      ],
    })
    const management = "Process moved to background. Use process wait."
    const emptyResult = entry({ kind: "toolResult", toolUseId: "empty-background", content: [{ type: "text", text: management }] })
    const outputResult = entry({ kind: "toolResult", toolUseId: "output-background", content: [{ type: "text", text: management }] })
    const toolResultMeta = new Map([
      ["empty-background", { background: true }],
      ["output-background", { background: true, executionOutput: "ready\n" }],
    ])
    const blocks = projectBlocksFromEntries([assistant, emptyResult, outputResult], { executionCwd: CWD, toolResultMeta })
    expect(blocks.filter((block) => block.kind === "tool").map((tool) => [tool.status, tool.content])).toEqual([
      ["completed", undefined],
      ["completed", "ready\n"],
    ])

    const lazy = new TreeBlockProjection({ executionCwd: CWD })
    for (const item of [assistant, emptyResult, outputResult]) lazy.add(item)
    const restored = lazy.snapshot().filter((block) => block.kind === "tool").map((base) => lazy.toolBlockReader(base).read(toolResultMeta.get(base.id)))
    expect(restored).toEqual(blocks)
    expect(Schema.encodeSync(Schema.Array(AnyBlockSchema))(restored)).toEqual(restored)
  })

  it("keeps block identity unique when a damaged branch repeats a toolUseId", () => {
    // A mid-turn provisional adoption racing the owner's save-point flush
    // double-records a turn: two assistant entries carry the same provider
    // tool_use id. Identity is the unified list/render/cursor key, so the
    // repeat occurrence must get a distinct block id while durable-fact joins
    // (result meta) still key on the provider id.
    const first = entry({ kind: "assistant", content: [{ type: "tool_use", id: "toolu_dup", name: "bash", input: { command: "echo hi" } }] })
    const firstResult = entry({ kind: "toolResult", toolUseId: "toolu_dup", content: [{ type: "text", text: "hi" }] })
    const copy = entry({ kind: "assistant", content: [{ type: "tool_use", id: "toolu_dup", name: "bash", input: { command: "echo hi" } }] })
    const copyResult = entry({ kind: "toolResult", toolUseId: "toolu_dup", content: [{ type: "text", text: "hi" }] })
    const blocks = projectBlocksFromEntries([first, firstResult, copy, copyResult], {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_dup", { executionOutput: "durable tail" }]]),
    })

    const tools = blocks.filter((block) => block.kind === "tool")
    expect(tools.map((tool) => tool.id)).toEqual(["toolu_dup", "toolu_dup#2"])
    expect(tools.map((tool) => tool.status)).toEqual(["completed", "completed"])
    expect(tools.map((tool) => tool.content)).toEqual(["durable tail", "durable tail"])
  })

  it("reconstructs Code as a display-only tool without source for every outcome", () => {
    const cases = [
      { id: "code-ok", result: entry({ kind: "toolResult", toolUseId: "code-ok", content: [{ type: "text", text: "value  \n" }] }), status: "completed" },
      { id: "code-failed", result: entry({ kind: "toolResult", toolUseId: "code-failed", content: [{ type: "text", text: "failed  \n" }], isError: true }), status: "error" },
      { id: "code-cut", result: entry({ kind: "toolResult", toolUseId: "code-cut", content: [{ type: "text", text: "partial  \n" }], interrupted: true }), status: "interrupted" },
    ] as const
    for (const testCase of cases) {
      // The Executed rail hides script source: the code display contract no
      // longer produces an invocation body, so reconstruction carries none.
      const source = `\nreturn ${testCase.id}\n`
      const use = entry({ kind: "assistant", content: [{ type: "tool_use", id: testCase.id, name: "code", input: { source } }] })
      const block = projectBlocksFromEntries([use, testCase.result], { executionCwd: CWD })[0]
      const content = testCase.result.message.content
      expect(block).toMatchObject({
        kind: "tool",
        name: "code",
        status: testCase.status,
        content: typeof content !== "string" && content[0]?.type === "text" ? content[0].text : "",
      })
      expect(block && "invocationBody" in block ? block.invocationBody : undefined).toBeUndefined()
    }
  })

  it("ignores retired Code details during ordinary reconstruction", () => {
    const use = entry({ kind: "assistant", content: [{ type: "tool_use", id: "code-old", name: "code", input: { source: "return 1" } }] })
    const result = entry({ kind: "toolResult", toolUseId: "code-old", content: [{ type: "text", text: "exact" }] })
    const block = projectBlocksFromEntries([use, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([["code-old", {}]]),
    })[0]
    expect(block).toMatchObject({ kind: "tool", name: "code", status: "completed", content: "exact" })
  })

  it("attaches recorded result diffs and filetypes to settled tools", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_meta", name: "replace", input: { files: ["a.ts"], old: "a", new: "b" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_meta", content: [{ type: "text", text: "ok" }] })
    const blocks = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_meta", { diff: "-a\n+b", filetype: "typescript" }]]),
    })

    const tool = blocks[0]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.status).toBe("completed")
    expect(tool.diff).toBe("-a\n+b")
    expect(tool.filetype).toBe("typescript")
  })

  it("attaches the skill mutation result action to a resumed tool", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_skill", name: "skill_manage", input: { action: "save", name: "example" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_skill", content: [{ type: "text", text: "written" }] })
    const blocks = projectBlocksFromEntries([assistant, result], {
      executionCwd: CWD,
      toolResultMeta: new Map([["toolu_skill", { resultAction: "updated" }]]),
    })

    const tool = blocks[0]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.presentation).toEqual({ name: "Save Skill", detail: "example" })
    expect(tool.status).toBe("completed")
    expect(tool.resultAction).toBe("updated")
  })

  it("names a message's recipient from its recorded result, as the live row does", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_msg", name: "message_session", input: { to: "3f2a-parent", text: "done" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_msg", content: [{ type: "text", text: "Delivered to 3f2a-parent." }] })
    const [named] = projectBlocksFromEntries([assistant, result], { executionCwd: CWD, toolResultMeta: new Map([["toolu_msg", { targetName: "Plan the release" }]]) })
    const unnamed = projectBlocksFromEntries([assistant, result], { executionCwd: CWD, toolResultMeta: new Map() })
    // The row also states the session it addresses, which the transcript
    // projection names by that session's title now.
    expect(named).toMatchObject({ kind: "tool", presentation: { name: "Message to", detail: "Plan the release" }, targetSessionId: "3f2a-parent" })
    expect(unnamed[0]).toMatchObject({ kind: "tool", presentation: { name: "Message to", detail: "3f2a-parent" } })
    // A held message states its outcome on the row, as the live row does.
    expect(projectBlocksFromEntries([assistant, result], { executionCwd: CWD, toolResultMeta: new Map([["toolu_msg", { targetName: "Plan the release", statusMessage: "Held: nothing runs it now." }]]) })[0]).toMatchObject({ kind: "tool", status: "blocked", statusMessage: "Held: nothing runs it now.", presentation: { detail: "Plan the release" } })

    // A loaded transcript folds without results and reads the meta of a row on demand.
    const lazy = new TreeBlockProjection({ executionCwd: CWD })
    for (const item of [assistant, result]) lazy.add(item)
    const base = lazy.snapshot()[0]
    if (base?.kind !== "tool" || named?.kind !== "tool") throw new Error("expected tool blocks")
    expect(lazy.toolBlockReader(base).read({ targetName: "Plan the release" })).toEqual(named)
  })

  it("derives historical presentation from successful durable machine invocations", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "toolu_load", name: "skill", input: { action: "load", skill_id: "implementation" } },
        { type: "tool_use", id: "toolu_res", name: "skill", input: { action: "resource", skill_id: "implementation", path: "references/guide.md" } },
      ],
    })
    const loadResult = entry({ kind: "toolResult", toolUseId: "toolu_load", content: [{ type: "text", text: "loaded" }] })
    const resourceResult = entry({ kind: "toolResult", toolUseId: "toolu_res", content: [{ type: "text", text: "read" }] })
    const blocks = project([assistant, loadResult, resourceResult])

    expect(blocks.map((block) => block.kind === "tool" ? { name: block.name, presentation: block.presentation } : block.kind)).toEqual([
      { name: "skill", presentation: { name: "Load Skill", detail: "implementation" } },
      { name: "skill", presentation: { name: "Read Skill Resource", detail: "implementation/references/guide.md" } },
    ])
  })

  it("keeps a malformed successful historical invocation on a safe family presentation", () => {
    const assistant = entry({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_bad", name: "skill", input: { action: "load", skill_id: 7, secret: "do-not-render" } }],
    })
    const result = entry({ kind: "toolResult", toolUseId: "toolu_bad", content: [{ type: "text", text: "legacy success" }] })
    const blocks = project([assistant, result])

    const tool = blocks[0]
    if (tool?.kind !== "tool") throw new Error("expected tool block")
    expect(tool.name).toBe("skill")
    expect(tool.presentation).toEqual({ name: "Load Skill", detail: "" })
  })

  it("marks error results and keeps unresolved tool_use as interrupted", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "toolu_err", name: "bash", input: { command: "boom" } },
        { type: "tool_use", id: "toolu_cut", name: "read", input: { path: "a.txt" } },
      ],
    })
    const errResult = entry({ kind: "toolResult", toolUseId: "toolu_err", content: [{ type: "text", text: "exploded" }], isError: true })
    const blocks = project([assistant, errResult])

    const [errTool, cutTool] = blocks
    if (errTool?.kind !== "tool" || cutTool?.kind !== "tool") throw new Error("expected tool blocks")
    expect(errTool.status).toBe("error")
    expect(errTool.status === "error" && errTool.errorMessage).toBe("Exploded")
    expect(cutTool.status).toBe("interrupted")
  })

  it("projects system, compaction, and branch-summary entries as system blocks", () => {
    const system = entry({ kind: "system", content: "runner restarted" })
    seq += 1
    const compaction: ConversationEntry = {
      id: `e${seq}`, parentId: system.id, timestamp: T0,
      kind: "compaction", summary: "long summary", retainedMessages: [], sourceLeafId: system.id, tokensBefore: 5000, tokensAfter: 250,
    }
    const blocks = project([system, compaction])

    expect(blocks).toEqual([
      { kind: "system", id: system.id, message: "runner restarted", timestamp: Date.parse(T0) },
      { kind: "system", id: compaction.id, message: "Context compacted: 5,000 → 250 tokens", timestamp: Date.parse(T0) },
    ])
  })

  it("renders a content-repair decision as one system block whose message is its note", () => {
    const decision = entry({ kind: "system", content: "The provider refused an image; it is withheld.", contentRepair: { kind: "withhold", toolUseId: "toolu_1", partIndex: 0, partKind: "image" } })

    expect(project([decision])).toEqual([
      { kind: "system", id: decision.id, message: "The provider refused an image; it is withheld.", timestamp: Date.parse(T0) },
    ])
  })

  it("carries a review notice's skill mutations onto its system block", async () => {
    const { stage, read } = sessionContentFixture()
    const mutation = buildMutationDiff([
      { path: "SKILL.md", before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } },
    ])
    const entries = await buildMutationDiffEntries(mutation, "review", stage)
    const mutationEvidence = await buildMutationEvidence(["patched", "support_file"].flatMap(action => entries.map(item => item.kind === "display"
      ? { ...item, file: { ...item.file, name: "provider-quirks", action, reach: "project" } } : item)), stage)
    const notice = entry({ kind: "system", content: "Updated skill: `provider-quirks`.", mutationEvidence })

    // No synthesized tool row: the evidence rides the one notice block.
    expect(project([notice])).toEqual([
      { kind: "system", id: notice.id, message: "Updated skill: `provider-quirks`.", timestamp: Date.parse(T0), mutationEvidence },
    ])
    const page = await readMutationEvidenceFiles(mutationEvidence, 0, 10, read)
    expect(page).toMatchObject({ kind: "available", nextOffset: null, files: [
      { kind: "display", file: { path: "SKILL.md", name: "provider-quirks", action: "patched", reach: "project" } },
      { kind: "display", file: { path: "SKILL.md", name: "provider-quirks", action: "support_file", reach: "project" } },
    ] })
    if (page.kind !== "available") throw new Error("expected notice files")
    for (const file of page.files) {
      if (file.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch")
      const range = await readSessionContentRange(file.file.patch.reference, 0, 4096, read)
      if (range.kind !== "available") throw new Error("expected patch bytes")
      expect(range.nextOffset).toBeNull()
      expect(Buffer.from(range.base64, "base64").toString()).toBe(mutation.files[0]!.unifiedDiff)
    }
  })

  it("includes displayOnly entries and skips label/leaf bookkeeping entries", () => {
    const diagnostic = entry({ kind: "system", content: "provider hiccup" }, { displayOnly: true })
    seq += 1
    const label: ConversationEntry = { id: `e${seq}`, parentId: diagnostic.id, timestamp: T0, kind: "label", targetId: diagnostic.id, label: "x" }
    seq += 1
    const leaf: ConversationEntry = { id: `e${seq}`, parentId: label.id, timestamp: T0, kind: "leaf", targetId: diagnostic.id }
    const blocks = project([diagnostic, label, leaf])

    expect(blocks).toEqual([
      { kind: "system", id: diagnostic.id, message: "provider hiccup", timestamp: Date.parse(T0) },
    ])
  })

  it("keeps user attachment markers and ordered image bodies separate from the words", () => {
    const user = entry({
      kind: "user",
      content: [
        { type: "text", text: "look at this [Image #1] [File #2 rows.csv]" },
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "<attachment name=\"rows.csv\" type=\"text/csv\">\na,b\n</attachment>" },
        { type: "image", mediaType: "image/jpeg", data: "Ynll" },
      ],
    })
    const blocks = project([user])

    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "look at this [Image #1] [File #2 rows.csv]", timestamp: Date.parse(T0), pending: false, injected: false,
        images: [{ mediaType: "image/png", data: "aGk=" }, { mediaType: "image/jpeg", data: "Ynll" }] },
    ])
  })

  it("flattens user content of another shape with one placeholder per part", () => {
    const user = entry({
      kind: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "after" },
      ],
    })
    const blocks = project([user])

    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "[image: image/png]\nafter", timestamp: Date.parse(T0), pending: false, injected: false,
        images: [{ mediaType: "image/png", data: "aGk=" }] },
    ])
  })

  it("retains image-only user messages", () => {
    const user = entry({ kind: "user", content: [{ type: "image", mediaType: "image/png", data: "aGk=" }] })
    expect(project([user])).toEqual([{
      kind: "userMessage", id: user.id, content: "[image: image/png]", timestamp: Date.parse(T0), pending: false, injected: false,
      images: [{ mediaType: "image/png", data: "aGk=" }],
    }])
  })

  it("keeps thinking as its own thought row between visible content and skips blank thinking and reasoning", () => {
    const assistant = entry({
      kind: "assistant",
      content: [
        { type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" },
        { type: "text", text: "before" },
        { type: "thinking", thinking: "chain", signature: "sig" },
        { type: "thinking", thinking: " ", signature: "blank" },
        { type: "text", text: "after" },
      ],
    })
    const blocks = project([assistant])

    // Each part keeps the row the live display streamed for it, at its own part index.
    expect(blocks).toEqual([
      { kind: "text", id: `${assistant.id}:1`, content: "before", timestamp: Date.parse(T0) },
      { kind: "thinking", id: `${assistant.id}:2`, content: "chain", status: "completed", timestamp: Date.parse(T0) },
      { kind: "text", id: `${assistant.id}:4`, content: "after", timestamp: Date.parse(T0) },
    ])
  })

  it("projects a degraded transcript record without exposing its raw envelope", () => {
    const rawEnvelope = {
      id: "conversation:c1:7", aggregateId: "conversation:c1", type: "chat.entries.appended", version: 1, position: 7,
      seq: 2, timestamp: 123, actor: "flywheel", sessionId: "s1", payload: { secret: "do-not-render" },
    }
    const blocks = projectBlocksFromEntries([{
      kind: "degraded",
      event: { aggregateId: rawEnvelope.aggregateId, type: rawEnvelope.type, version: rawEnvelope.version, position: rawEnvelope.position },
      sourceEntryId: "orphan",
      sourceParentId: "missing",
      ordinal: 0,
      raw: rawEnvelope,
      anchorLeafId: null,
      block: {
        kind: "degraded",
        id: "conversation:c1:7:0",
        factFamily: "chat_tree",
        failureClass: "structural_violation",
        eventType: "chat.entries.appended",
        eventVersion: 1,
        eventPosition: 7,
        notice: "Part of this transcript could not be displayed.",
        timestamp: 123,
      },
    }], { executionCwd: CWD })

    expect(blocks).toEqual([{
      kind: "degraded",
      id: "conversation:c1:7:0",
      factFamily: "chat_tree",
      failureClass: "structural_violation",
      eventType: "chat.entries.appended",
      eventVersion: 1,
      eventPosition: 7,
      notice: "Part of this transcript could not be displayed.",
      timestamp: 123,
    }])
    expect(JSON.stringify(blocks)).not.toContain("do-not-render")
  })
})
