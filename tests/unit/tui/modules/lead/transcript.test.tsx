/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../../../src/protocol/app-service-types.js"
import { formatStartTime } from "../../../../../src/protocol/client/format.js"
import { foldTurns, turnFoldSummary } from "../../../../../src/protocol/client/turn-folds.js"
import { ClientExtensionsProvider } from "../../../../../src/tui/context/client-extensions.js"
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
  const rows = [person, ...work, answer]
  const fold = foldTurns({ rows, boundaryBefore: rows.map(() => false) }, true).rows[1]
  if (fold?.kind !== "turnFold") throw new Error("the turn did not fold")
  return turnFoldSummary(fold, undefined, LEAD_TRANSCRIPT.phrases).label
}

/** The tab of `sessionId` over `blocks`, under the real lead client, whose first tab is `LEAD_ID`. */
async function mountTab(sessionId: string, blocks: readonly FrontendOutputBlock[], running = false) {
  const lead = leadHarness([])
  const disclosure = createBlockDisclosureChannel()
  const result = await testRender(() => (
    <ThemeProvider mode="dark"><TickPoolProvider><ClientExtensionsProvider value={[lead.client]}>
      <OutputWindow
        layoutSlot={{ sessionId }}
        transcript={{ ...transcriptOf(blocks), ...disclosure }}
        running={running}
        sessionIntro={{
          moduleRows: () => [], runtimeIdentity: () => ({ version: "0.0.1", buildId: null }), showBuild: () => false,
          projectRoot: () => "/Users/test/project", accountHome: "/Users/test", userDataRoot: "/Users/test/.flywheel",
          branchName: () => undefined, sessionKind: () => "subagent", modelLabel: () => "model", profileName: () => "default",
          fontTipDismissed: () => false, tabsHintDismissed: () => false, onDismissTabsHint: () => {}, availableWidth: () => 80, noProviderReady: () => false,
        }}
      />
    </ClientExtensionsProvider></TickPoolProvider></ThemeProvider>
  ), { width: 100, height: 30 })
  const frame = async (): Promise<string> => {
    await result.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await result.renderOnce()
    return result.captureCharFrame()
  }
  return { result, frame, dispose: () => { result.renderer.destroy(); lead.dispose() } }
}

describe("the lead's tab folds its finished turns to their answers (PI-LEAD-011)", () => {
  it("says what the lead did with its chats in place of a tool count", () => {
    expect(labelOf([progress, route])).toBe("Worked 4s · checked chats, started 1 chat")
    expect(labelOf([
      progress, { ...progress, id: "again" },
      call("one", "route_request", "Route to"), call("two", "route_request", "Route to"), route, { ...route, id: "new-2" },
      call("ls", "bash", "Bash", "shell_exec"), call("read", "read", "Read", "file_read"),
    ])).toBe("Worked 4s · checked chats, started 2 chats, sent to 2 chats, ran 1 command, used 1 tool")
  })

  it("shows one muted line above the answer, and a click opens every row but the bookkeeping", async () => {
    const tab = await mountTab(LEAD_ID, turn)
    try {
      const folded = await tab.frame()
      const line = "Worked 4s · checked chats, started 1 chat"
      // The line opens with the time the person's message arrived, as on the web client.
      expect(folded).toContain(`▸ ${formatStartTime(person.timestamp)} · ${line}`)
      expect(folded.indexOf(line)).toBeLessThan(folded.indexOf("A new chat investigates it"))
      expect(folded).toContain("Look into the flaky test")
      for (const hidden of ["No chat works on this yet", "Chat progress", "Route to new chat", "Checkpoint"]) expect(folded).not.toContain(hidden)
      const theme = resolveTheme(flywheelTheme, "dark")
      const span = tab.result.captureSpans().lines.flatMap((row) => row.spans).find((candidate) => candidate.text.includes("Worked"))
      expect(span?.fg.equals(theme.textMuted)).toBe(true)

      const rows = folded.split("\n")
      const y = rows.findIndex((row) => row.includes(line))
      await tab.result.mockMouse.click(rows[y]!.indexOf("Worked") + 2, y)
      const opened = await tab.frame()
      expect(opened).toContain(line)
      for (const shown of ["No chat works on this yet", "Chat progress", "Route to new chat"]) expect(opened).toContain(shown)
      expect(opened).not.toContain("Checkpoint")
    } finally { tab.dispose() }
  })

  it("ends a turn at a chat's report, which stays in view with the lead's reply to it", async () => {
    const report: FrontendOutputBlock = {
      kind: "userMessage", id: "msg:done:lead-report:final", content: "The build passes now.", timestamp: 6000, pending: false, injected: false,
      from: { sessionId: "done", name: "DAG Failures", relation: "other" },
    }
    const reply: FrontendOutputBlock = { kind: "text", id: "reply", content: "DAG Failures finished: the build passes.", timestamp: 9000 }
    const tab = await mountTab(LEAD_ID, [...turn, report, { ...progress, id: "after", timestamp: 7000 }, reply])
    try {
      const frame = await tab.frame()
      expect(frame).toContain("Worked 4s · checked chats, started 1 chat")
      expect(frame).not.toContain("Worked 8s")
      expect(frame).toContain("DAG Failures")
      expect(frame).toContain("Chat progress")
      expect(frame).toContain("DAG Failures finished: the build passes.")
    } finally { tab.dispose() }
  })

  it("keeps a settled fold folded when the tab mounts again while the next turn runs", async () => {
    const asked: FrontendOutputBlock = { ...person, id: "asked", content: "Which chat owns the parser?" }
    const thought: FrontendOutputBlock = { ...narration, id: "thought", content: "I will check my chats first." }
    const replied: FrontendOutputBlock = { ...answer, id: "replied", content: "The parser chat owns it." }
    const settled = [asked, thought, { ...progress, id: "checked" }, replied]
    const first = await mountTab(LEAD_ID, settled)
    try { expect(await first.frame()).toContain("Worked 4s · checked chats") } finally { first.dispose() }
    const next: FrontendOutputBlock = { ...person, id: "next", content: "And the lexer?", timestamp: 9000 }
    const second = await mountTab(LEAD_ID, [...settled, next, { ...progress, id: "checking", status: "pending", timestamp: 9500 }], true)
    try {
      const frame = await second.frame()
      expect(frame).toContain("Worked 4s · checked chats")
      expect(frame).not.toContain("I will check my chats first.")
      expect(frame).toContain("The parser chat owns it.")
    } finally { second.dispose() }
  })

  it("folds nothing while a turn runs", async () => {
    const tab = await mountTab(LEAD_ID, [person, narration, progress, checkpoint, { ...route, status: "pending" }], true)
    try {
      const frame = await tab.frame()
      expect(frame).not.toContain("Worked")
      expect(frame).toContain("Chat progress")
      expect(frame).not.toContain("Checkpoint")
    } finally { tab.dispose() }
  })

  it("leaves an ordinary chat's finished turn and its bookkeeping in view", async () => {
    const tab = await mountTab("chat-2", turn)
    try {
      const frame = await tab.frame()
      expect(frame).not.toContain("Worked")
      for (const shown of ["No chat works on this yet", "Chat progress", "Route to new chat", "Checkpoint"]) expect(frame).toContain(shown)
    } finally { tab.dispose() }
  })
})
