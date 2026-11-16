/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../../src/protocol/app-service-types.js"
import { formatStartTime } from "../../../../../src/protocol/client/format.js"
import { gatherCallStretches, turnFoldSummary } from "../../../../../src/protocol/client/turn-folds.js"
import { projectFrontendOutputBlocks } from "../../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { projectBlocksFromEntries } from "../../../../../src/orchestration/session/conversation/conversation-block-projection.js"
import type { ConversationTreeTranscriptEntry } from "../../../../../src/orchestration/session/conversation/conversation-projection.js"
import { leadEntryLink } from "../../../../../src/protocol/modules/lead.js"
import { ClientExtensionProviders, ClientExtensionsProvider } from "../../../../../src/tui/context/client-extensions.js"
import { NavigationProvider } from "../../../../../src/tui/context/navigation.js"
import { createBlockDisclosureChannel } from "../../../../../src/tui/context/block-disclosure.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { LEAD_TRANSCRIPT } from "../../../../../src/tui/modules/lead/transcript.js"
import { OutputWindow } from "../../../../../src/tui/output-window/output-window.js"
import { transcriptOf } from "../../_output-window-transcript.js"
import { LEAD_ID, leadHarness } from "./_lead-fixtures.js"

const person: FrontendOutputBlock = { kind: "userMessage", id: "person", content: "Look into the flaky test", timestamp: 1000, pending: false, injected: false }
const narration: FrontendOutputBlock = { kind: "text", id: "narration", content: "No chat works on this yet, so I will start one.", timestamp: 1500 }
const answer: FrontendOutputBlock = { kind: "text", id: "answer", content: "A new chat investigates it and reports back.", timestamp: 5000 }

function call(id: string, name: string, presentation: string, action: FrontendToolEntry["action"] = "ui_meta", status: "completed" | "pending" = "completed"): FrontendToolEntry {
  return { kind: "tool", id, name, action, presentation: { name: presentation, detail: "" }, status, timestamp: 2000 }
}

const progress = call("progress", "chat_progress", "Chat progress")
const route = call("route", "route_request", "Route to new chat")
const checkpoint = call("checkpoint", "checkpoint_replace", "Update Checkpoint")
const turn = [person, narration, progress, route, checkpoint, answer]

function labelOf(work: readonly FrontendOutputBlock[]): string {
  const rows = [...work, answer]
  const stretch = gatherCallStretches({ rows, boundaryBefore: rows.map(() => false) }, false).rows[0]
  if (stretch?.kind !== "callStretch") throw new Error("the calls gathered under no heading")
  return turnFoldSummary(stretch, undefined, LEAD_TRANSCRIPT.phrases).label
}

/** The tab of `sessionId` over `blocks`, under the real lead client and its providers, whose first tab is `LEAD_ID`.
 *  `navigated` records each link that a click opens. */
async function mountTab(sessionId: string, blocks: readonly FrontendOutputBlock[], running = false, height = 30, sessionKind: "chat" | "subagent" = "subagent", titles?: { readonly [sessionId: string]: string }) {
  const lead = leadHarness([], {}, undefined, titles)
  const disclosure = createBlockDisclosureChannel()
  const navigated: string[] = []
  const result = await testRender(() => (
    <ThemeProvider mode="dark"><TickPoolProvider><ClientExtensionsProvider value={[lead.client]}><ClientExtensionProviders><NavigationProvider value={(uri) => { navigated.push(uri) }}>
      <OutputWindow
        layoutSlot={{ sessionId }}
        transcript={{ ...transcriptOf(blocks), ...disclosure }}
        running={running}
        sessionIntro={{
          moduleRows: () => [], runtimeIdentity: () => ({ version: "0.0.1", buildId: null }), showBuild: () => false,
          projectRoot: () => "/Users/test/project", accountHome: "/Users/test", userDataRoot: "/Users/test/.flywheel",
          branchName: () => undefined, sessionKind: () => sessionKind, modelLabel: () => "model", profileName: () => "default",
          fontTipDismissed: () => false, tabsHintDismissed: () => false, onDismissTabsHint: () => {}, availableWidth: () => 80, noProviderReady: () => false,
        }}
      />
    </NavigationProvider></ClientExtensionProviders></ClientExtensionsProvider></TickPoolProvider></ThemeProvider>
  ), { width: 100, height })
  const frame = async (): Promise<string> => {
    await result.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await result.renderOnce()
    return result.captureCharFrame()
  }
  return { result, frame, navigated, dispose: () => { result.renderer.destroy(); lead.dispose() } }
}

/** The lead's conversation as the installed build wrote it in a live run: two routes, a report after each, and
 *  between them a turn that a chat's question started and that ended with no answer. The system reminders and the
 *  provider fields of each message are left out. */
const LIVE_LEAD_ENTRIES: readonly ConversationTreeTranscriptEntry[] = [
  { id: "person:7e1fa464", parentId: null, timestamp: "2026-11-15T08:16:15.470Z", kind: "message", message: { kind: "user", content: "Start a chat that lists the files in the project root, then reports. Keep it tiny.", origin: "human", submissionIds: ["7e1fa464"] } },
  { id: "98d03266", parentId: "person:7e1fa464", timestamp: "2026-11-15T08:16:18.088Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "I’ll start a chat to list the root files and report briefly.\n" }, { type: "tool_use", id: "call_4551", name: "route_request", input: { kind: "new" } }], stopReason: "tool_use" } },
  { id: "321736cd", parentId: "98d03266", timestamp: "2026-11-15T08:16:18.144Z", kind: "message", message: { kind: "toolResult", toolUseId: "call_4551", content: [{ type: "text", text: "Started chat 99b414b85fde \"New Chat\" with the person's messages." }] } },
  { id: "9441f1c2", parentId: "321736cd", timestamp: "2026-11-15T08:16:19.951Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "The root-file listing chat has it and will report back here." }], stopReason: "end_turn" } },
  { id: "msg:99b414b85fde:lead-report:71e0915a", parentId: "9441f1c2", timestamp: "2026-11-15T08:16:31.546Z", kind: "message", message: { kind: "user", content: "Done. The project root has no files, only two directories: `.flywheel/` and `.git/`.", producer: { kind: "session", sessionId: "99b414b85fde", conversationId: "2293ecac3cf5", toolUseId: "lead-report:71e0915a", hop: 0, envelope: { name: "List Project Root Files", relation: "other", waits: false } } } },
  { id: "b229df2f", parentId: "msg:99b414b85fde:lead-report:71e0915a", timestamp: "2026-11-15T08:16:33.363Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "The chat reports no root files." }], stopReason: "end_turn" } },
  { id: "person:dbbea66c", parentId: "b229df2f", timestamp: "2026-11-15T08:17:57.496Z", kind: "message", message: { kind: "user", content: "Start a new chat that asks me with ask_user to pick red or blue, then reports my pick in one line.", origin: "human", submissionIds: ["dbbea66c"] } },
  { id: "a412be6a", parentId: "person:dbbea66c", timestamp: "2026-11-15T08:17:59.647Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "I’ll start a new chat to ask for your choice.\n" }, { type: "tool_use", id: "call_6093", name: "route_request", input: { kind: "new" } }], stopReason: "tool_use" } },
  { id: "9841c570", parentId: "a412be6a", timestamp: "2026-11-15T08:17:59.691Z", kind: "message", message: { kind: "toolResult", toolUseId: "call_6093", content: [{ type: "text", text: "Started chat e1c82693293b \"New Chat\" with the person's messages." }] } },
  { id: "2abebaef", parentId: "9841c570", timestamp: "2026-11-15T08:18:02.424Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "The color-choice chat has it and will report your pick here." }], stopReason: "end_turn" } },
  { id: "5cba8910", parentId: "2abebaef", timestamp: "2026-11-15T08:18:03.110Z", kind: "message", message: { kind: "user", content: "<session_event_notice>\n<source>runtime</source>\n<visibility>hidden_from_user</visibility>\n<chat><session_id>e1c82693293b</session_id><title>Pick Red or Blue</title><event>asked</event></chat>\n</session_event_notice>", origin: "system" } },
  { id: "ff4f49bc", parentId: "5cba8910", timestamp: "2026-11-15T08:18:06.334Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "I’ll check the color chat’s question for any needed context.\n" }, { type: "tool_use", id: "call_1eb8", name: "chat_progress", input: { chat: "e1c82693293b" } }], stopReason: "tool_use" } },
  { id: "eeee34cd", parentId: "ff4f49bc", timestamp: "2026-11-15T08:18:06.339Z", kind: "message", message: { kind: "toolResult", toolUseId: "call_1eb8", content: [{ type: "text", text: "Chat e1c82693293b \"Pick Red or Blue\": waiting for the person's answer." }] } },
  { id: "msg:e1c82693293b:lead-report:166f9bae", parentId: "eeee34cd", timestamp: "2026-11-15T08:18:36.257Z", kind: "message", message: { kind: "user", content: "Done: You picked blue.", producer: { kind: "session", sessionId: "e1c82693293b", conversationId: "f29d55e69a36", toolUseId: "lead-report:166f9bae", hop: 0, envelope: { name: "Pick Red or Blue", relation: "other", waits: false } } } },
  { id: "9b39c6c8", parentId: "msg:e1c82693293b:lead-report:166f9bae", timestamp: "2026-11-15T08:18:38.209Z", kind: "message", message: { kind: "assistant", content: [{ type: "text", text: "The chat reports you picked blue." }], stopReason: "end_turn" } },
]

describe("the lead's tab gathers its calls under one heading per stretch (PI-LEAD-017)", () => {
  it("says what the lead did with its chats in place of a tool count", () => {
    expect(labelOf([progress, route])).toBe("Worked 3s · checked chats, started 1 chat")
    expect(labelOf([
      progress, { ...progress, id: "again" },
      call("one", "route_request", "Route to"), call("two", "route_request", "Route to"), route, { ...route, id: "new-2" },
      call("ls", "bash", "Bash", "shell_exec"), call("read", "read", "Read", "file_read"),
    ])).toBe("Worked 3s · checked chats, started 2 chats, sent to 2 chats, ran 1 command, used 1 tool")
  })

  it("keeps the narration and the answer in view around one closed muted heading, and a click opens the calls indented beneath it, without the bookkeeping", async () => {
    const tab = await mountTab(LEAD_ID, turn)
    try {
      const closed = await tab.frame()
      const line = "Worked 3s · checked chats, started 1 chat"
      // The heading opens with the time the first call of the stretch started.
      expect(closed).toContain(`▸ ${formatStartTime(progress.timestamp)} · ${line}`)
      expect(closed.indexOf("No chat works on this yet")).toBeLessThan(closed.indexOf(line))
      expect(closed.indexOf(line)).toBeLessThan(closed.indexOf("A new chat investigates it"))
      expect(closed).toContain("Look into the flaky test")
      for (const hidden of ["Chat progress", "Route to new chat", "Checkpoint"]) expect(closed).not.toContain(hidden)
      const theme = resolveTheme(flywheelTheme, "dark")
      const span = tab.result.captureSpans().lines.flatMap((row) => row.spans).find((candidate) => candidate.text.includes("Worked"))
      expect(span?.fg.equals(theme.textMuted)).toBe(true)

      const rows = closed.split("\n")
      const y = rows.findIndex((row) => row.includes(line))
      await tab.result.mockMouse.click(rows[y]!.indexOf("Worked") + 2, y)
      const opened = await tab.frame()
      expect(opened).toContain(`▾ ${formatStartTime(progress.timestamp)} · ${line}`)
      for (const shown of ["No chat works on this yet", "Chat progress", "Route to new chat", "A new chat investigates it"]) expect(opened).toContain(shown)
      expect(opened).not.toContain("Checkpoint")
      // The calls' run sits two columns in from the heading.
      const openedRows = opened.split("\n")
      const headingColumn = openedRows.find((row) => row.includes(line))!.indexOf("▾")
      expect(openedRows.find((row) => row.includes("Ran ·"))!.search(/\S/)).toBe(headingColumn + 2)
    } finally { tab.dispose() }
  })

  it("shows the running stretch open with its calls beneath, and closes it once the lead's next words follow", async () => {
    const running = await mountTab(LEAD_ID, [person, narration, progress, checkpoint, { ...route, status: "pending" }], true)
    try {
      const frame = await running.frame()
      expect(frame).toContain(`▾ ${formatStartTime(progress.timestamp)} · Working · checked chats, started 1 chat`)
      expect(frame).toContain("No chat works on this yet")
      expect(frame).toContain("Chat progress")
      expect(frame).not.toContain("Checkpoint")
    } finally { running.dispose() }
    // A route whose input has not yet said whether it starts a chat adds no phrase.
    const unknown = await mountTab(LEAD_ID, [person, narration, call("routing", "route_request", "Route", "ui_meta", "pending")], true)
    try {
      const frame = await unknown.frame()
      expect(frame).toContain(`▾ ${formatStartTime(progress.timestamp)} · Working`)
      expect(frame).not.toContain("Working ·")
    } finally { unknown.dispose() }
    const answered = await mountTab(LEAD_ID, [...turn, { ...person, id: "next", content: "And the lexer?", timestamp: 9000 }, { ...progress, id: "checking", status: "pending", timestamp: 9500 }], true)
    try {
      const frame = await answered.frame()
      expect(frame).toContain(`▸ ${formatStartTime(progress.timestamp)} · Worked 3s · checked chats, started 1 chat`)
      expect(frame).toContain(`▾ ${formatStartTime(9500)} · Working · checked chats`)
      expect(frame).toContain("A new chat investigates it")
      expect(frame.split("Chat progress").length - 1).toBe(1)
    } finally { answered.dispose() }
  })

  it("ends a stretch at a chat's report, which stays in view with the lead's reply to it", async () => {
    const report: FrontendOutputBlock = {
      kind: "userMessage", id: "msg:done:lead-report:final", content: "The build passes now.", timestamp: 6000, pending: false, injected: false,
      from: { sessionId: "done", name: "DAG Failures", relation: "other" },
    }
    const reply: FrontendOutputBlock = { kind: "text", id: "reply", content: "DAG Failures finished: the build passes.", timestamp: 9000 }
    const tab = await mountTab(LEAD_ID, [...turn, report, { ...progress, id: "after", timestamp: 7000 }, reply])
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Worked 3s · checked chats, started 1 chat")
      expect(frame).toContain(`▸ ${formatStartTime(7000)} · Worked 2s · checked chats`)
      expect(frame).toContain("DAG Failures")
      expect(frame).not.toContain("Chat progress")
      expect(frame.indexOf("Report · ")).toBeLessThan(frame.indexOf("Worked 2s"))
      expect(frame).toContain("DAG Failures finished: the build passes.")
    } finally { tab.dispose() }
    // Calls that end their turn with no words after them last until the last one returned, never until the report.
    const quiet = await mountTab(LEAD_ID, [person, narration, { ...progress, settledAt: 8900 }, report])
    try {
      expect(await quiet.frame()).toContain(`▸ ${formatStartTime(progress.timestamp)} · Worked 6s · checked chats`)
    } finally { quiet.dispose() }
  })

  it("shows a chat's own message as one Update line that ends the stretch before it and opens the chat at its call", async () => {
    const update: FrontendOutputBlock = {
      kind: "userMessage", id: "msg:done:call-7", content: "Done: PR 42 is open, and I wait on its CI.", timestamp: 6000, pending: false, injected: false,
      from: { sessionId: "done", name: "DAG Failures", relation: "other" },
    }
    const reply: FrontendOutputBlock = { kind: "text", id: "reply", content: "DAG Failures opened PR 42 and waits on CI.", timestamp: 9000 }
    const tab = await mountTab(LEAD_ID, [...turn, update, { ...progress, id: "after", timestamp: 7000 }, reply])
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Worked 3s · checked chats, started 1 chat")
      expect(frame).toContain(`▸ ${formatStartTime(7000)} · Worked 2s · checked chats`)
      expect(frame).toContain("Update · Chat done · open")
      expect(frame).not.toContain("PR 42 is open")
      expect(frame.indexOf("Update · ")).toBeLessThan(frame.indexOf("Worked 2s"))
      expect(frame).toContain("DAG Failures opened PR 42 and waits on CI.")
      const rows = frame.split("\n")
      const y = rows.findIndex((row) => row.includes("Update · Chat done · open"))
      await tab.result.mockMouse.click(rows[y]!.lastIndexOf("open") + 1, y)
      expect(tab.navigated).toEqual([leadEntryLink("done", "call-7")])
    } finally { tab.dispose() }
  })

  it("keeps the ordinary disclosure for a message from another session on any tab but the lead's", async () => {
    const queued: FrontendOutputBlock = {
      kind: "userMessage", id: "msg:peer:call-3", content: "The header check fails in your file.", timestamp: 6000, pending: true, injected: false,
      from: { sessionId: "peer", name: "Header Fix", relation: "other" },
    }
    const tab = await mountTab("other-chat", [person, queued], false, 30, "chat")
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Message from")
      expect(frame).not.toContain("Update ·")
    } finally { tab.dispose() }
  })

  it("shows each report of a live run as its own line, keeps the words of a turn that ended on a call above its closed heading, and a click opens the report", async () => {
    // The rows that a reload reads: the runtime's own projection of the stored entries.
    const blocks = projectFrontendOutputBlocks(projectBlocksFromEntries(LIVE_LEAD_ENTRIES, { executionCwd: "/project" }))
    // The second chat was renamed after its report: the line names it as the Sessions list does now.
    const tab = await mountTab(LEAD_ID, blocks, false, 60, "subagent", { "99b414b85fde": "List Project Root Files", "e1c82693293b": "Pick a Color" })
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Report · List Project Root Files · open")
      expect(frame).toContain("Report · Pick a Color · open")
      expect(frame).not.toContain("Message from")
      // The turn that the question started ended on its call: its words stay in view, and its call sits under a closed
      // heading. The call returned 5 ms after it started, so the heading truly reads 0s.
      const quietHeading = `▸ ${formatStartTime(Date.parse("2026-11-15T08:18:06.334Z"))} · Worked 0s · checked chats`
      expect(frame).toContain("I’ll check the color chat’s question")
      expect(frame).toContain(quietHeading)
      expect(frame.indexOf("I’ll check the color chat’s question")).toBeLessThan(frame.indexOf(quietHeading))
      expect(frame).toContain("I’ll start a chat to list the root files")
      expect(frame).toContain("Worked 1s · started 1 chat")
      expect(frame).not.toContain("Chat progress")
      const rows = frame.split("\n")
      const y = rows.findIndex((row) => row.includes("Report · Pick a Color · open"))
      await tab.result.mockMouse.click(rows[y]!.lastIndexOf("open") + 1, y)
      expect(tab.navigated).toEqual([leadEntryLink("e1c82693293b", "166f9bae")])
    } finally { tab.dispose() }
  })

  it("teaches tab keys in the welcome block of every tab but the lead's (PI-LEAD-014)", async () => {
    for (const [sessionId, taught] of [[LEAD_ID, false], ["other", true]] as const) {
      const tab = await mountTab(sessionId, [], false, 30, "chat")
      try {
        const frame = await tab.frame()
        expect(frame).toContain("project:")
        expect(frame.includes("Each tab is one session")).toBe(taught)
      } finally { tab.dispose() }
    }
  })

  it("leaves an ordinary chat's calls and bookkeeping in view, with no heading", async () => {
    const tab = await mountTab("chat-2", turn)
    try {
      const frame = await tab.frame()
      expect(frame).not.toContain("Worked")
      for (const shown of ["No chat works on this yet", "Chat progress", "Route to new chat", "Checkpoint"]) expect(frame).toContain(shown)
    } finally { tab.dispose() }
  })
})
