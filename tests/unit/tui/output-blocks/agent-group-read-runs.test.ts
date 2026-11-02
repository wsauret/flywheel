import { describe, expect, it } from "bun:test"
import type { WorkflowCards } from "../../../../src/tui/modules/workflows/cards.js"
import { workflowDetail } from "../../../helpers/runtime-views.js"
import type { ToolEntry, AgentGroupBlock as AgentGroupBlockType } from "../../../../src/infra/output-blocks.js"
import { getToolDisplay, resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import { createSignal } from "solid-js"
import { resolvedTheme, sameColor, spanColor } from "../components/prompt-border-fixtures.js"
import { workflowCard as foldWorkflowCard } from "../../../../src/protocol/client/workflow-card.js"
import { displayWidth } from "../../../../src/tui/utils/text.js"
import type { RowProcessControls } from "../../../../src/tui/output-blocks/stop-affordance.js"
import { FANOUT, FANOUT_FAILED, timedFanoutOutline, type FanoutFixture } from "../../protocol/client/_workflow-card-fixtures.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { renderToolGroup } from "./_agent-group-render.js"

const CWD = "/workspace"

/** A child row as the projectors build it: raw machine name, resolver-owned
 *  presentation, and the file link production attaches to a path read. */
function read(path: string): ToolEntry {
  return {
    kind: "tool",
    id: `read-${path}`,
    name: "read",
    action: getToolDisplay("read").action,
    presentation: resolveToolPresentation("read", { path: `${CWD}/${path}` }, CWD),
    linkUri: `file://${CWD}/${path}`,
    status: "completed",
    timestamp: 0,
  }
}

function exec(command: string, content: string): ToolEntry {
  return {
    kind: "tool",
    id: `bash-${command}`,
    name: "bash",
    action: getToolDisplay("bash").action,
    presentation: resolveToolPresentation("bash", { command }, CWD),
    status: "completed",
    content,
    timestamp: 0,
  }
}

async function edit(paths: readonly string[]): Promise<ToolEntry> {
  const input = paths.map((path, index) => `@@ ${path}\n= ${index + 1}aa..${index + 1}aa\n~changed`).join("\n")
  const evidence = await mutationEvidenceFixture(paths.map(path => ({ path })))
  return {
    kind: "tool",
    id: `edit-${paths.join("-")}`,
    name: "edit",
    action: getToolDisplay("edit").action,
    presentation: resolveToolPresentation("edit", { input }, CWD),
    status: "completed",
    mutationEvidence: evidence.evidence,
    timestamp: 0,
  }
}

describe("AgentGroupBlock read runs", () => {
  it("shows only the server-selected newest read on one unboxed agent line", async () => {
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 3,
      label: "Explorer",
      description: "Trace rendering",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      children: [read("src/a.ts"), read("src/b.ts"), read("src/c.ts")],
      activity: { name: "Read", detail: "src/c.ts" },
      timestamp: Date.now(),
    })

    expect(frame).toContain("└ ● Read src/c.ts")
    expect(frame).not.toContain("src/a.ts")
    expect(frame).not.toContain("│")
    expect(frame.match(/\bRead\b/g)).toHaveLength(1)
  })

  it("shows every path for a compact multi-file edit without rendering its diffs", async () => {
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 1,
      label: "Implementer",
      description: "Update both files",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      children: [await edit(["src/first.ts", "src/second.ts"])],
      activity: { name: "Edited", detail: "src/first.ts, src/second.ts" },
      timestamp: Date.now(),
    })

    expect(frame).toContain("Edited src/first.ts, src/second.ts")
    expect(frame).not.toContain("before")
    expect(frame).not.toContain("after")
  })

  it("keeps one agent line as the operation count grows", async () => {
    const activeBlock = (children: ToolEntry[]): AgentGroupBlockType => ({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: children.length,
      label: "Explorer",
      description: "Trace rendering",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      children,
      activity: { name: "Ran", detail: `command-${children.length}` },
      timestamp: Date.now(),
    })
    const renderedRows = (frame: string) => frame.split("\n").filter((line) => line.includes("└"))

    for (let lineCount = 1; lineCount <= 4; lineCount += 1) {
      const children = Array.from({ length: lineCount }, (_, index) => exec(`command-${index + 1}`, ""))
      const frame = await renderToolGroup(activeBlock(children))
      expect(renderedRows(frame)).toHaveLength(1)
      expect(frame).toContain(`Ran command-${lineCount}`)
    }
  })

  it("cuts a long newest call to one line while keeping the time in the header", async () => {
    const children = Array.from({ length: 6 }, (_, index) =>
      exec(`command-${index + 1} ${"argument ".repeat(8)}`, ""),
    )
    const block: AgentGroupBlockType = {
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: children.length,
      label: "Explorer",
      description: "Trace rendering",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      children,
      activity: { name: "Ran", detail: `command-6 ${"argument ".repeat(8)}` },
      duration: 7000,
      timestamp: Date.now(),
    }

    const frame = await renderToolGroup(block, { width: 48 })
    const renderedRows = (output: string) => output.split("\n").filter((line) => line.includes("└"))

    expect(renderedRows(frame)).toHaveLength(1)
    expect(renderedRows(frame)[0]).not.toContain("7s")
    expect(frame.split("\n").find((line) => line.includes("Explorer"))).toContain("gpt-6-astra high · 7s")
    expect(displayWidth(renderedRows(frame)[0]?.trimEnd() ?? "")).toBe(48)
    expect(frame).not.toContain("command-1")
    expect(frame).toContain("command-6")
  })

  it("starts at live work or a resumed call, then updates the one muted agent line in place", async () => {
    const [firstBlock, setFirstBlock] = createSignal<AgentGroupBlockType>({
      kind: "agentGroup", containerKind: "subagent", id: "agent-first", toolUseId: "tu-first", totalToolCount: 0,
      label: "Explorer", description: "Trace rendering", status: "active", children: [],
      model: "gpt-6-astra high", linkUri: "flywheel://session/child-first",
      timestamp: Date.now(), duration: 7000,
    })
    const firstCallFrame = await renderToolGroup(firstBlock(), {
      block: firstBlock, childStatus: () => ({ waitingOn: undefined, activity: "thinking" }), width: 140,
      updateAfterFirstRender(frame) {
        const rows = frame.split("\n").filter((line) => line.includes("└"))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toContain("└ ● Thinking")
        expect(rows[0]).not.toContain("7s")
        expect(frame.split("\n").find((line) => line.includes("Explorer"))).toContain("gpt-6-astra high · 7s")
        setFirstBlock({ ...firstBlock(), activity: { name: "Read", detail: "first.ts" }, totalToolCount: 1 })
      },
    })
    expect(firstCallFrame.split("\n").filter((line) => line.includes("└"))).toHaveLength(1)
    expect(firstCallFrame).toContain("Read first.ts")
    expect(firstCallFrame).not.toContain("Thinking")
    await renderToolGroup({ ...firstBlock(), activity: undefined }, {
      childStatus: () => ({ waitingOn: undefined, activity: "thinking" }),
      inspectSpans(frame) { expect(sameColor(spanColor(frame, "Thinking")!, resolvedTheme.textMuted)).toBe(true) },
    })
    const earlier = Array.from({ length: 5 }, (_, index) => exec(`command-${index + 1}`, ""))
    const [block, setBlock] = createSignal<AgentGroupBlockType>({
      kind: "agentGroup", containerKind: "subagent", id: "agent-1", toolUseId: "tu-agent-1", totalToolCount: earlier.length,
      label: "Explorer resume", description: "Trace rendering", status: "active", children: earlier,
      activity: { name: "Ran", detail: "command-5" },
      model: "gpt-6-astra high", linkUri: "flywheel://session/child-1",
      timestamp: Date.now() - 3_600_000, duration: 7000, totalTokens: 900,
    })
    const frame = await renderToolGroup(block(), { block, width: 140, updateAfterFirstRender(firstFrame) {
      const seeded = firstFrame.split("\n").filter((line) => line.includes("└"))
      expect(seeded).toHaveLength(1)
      expect(seeded.join("\n")).not.toContain("command-1")
      expect(seeded.join("\n")).toContain("command-5")
      expect(firstFrame).not.toContain("tokens")
      expect(firstFrame).toContain("7s")
      expect(firstFrame).not.toContain("1h")
      expect(firstFrame).not.toContain("60m")
      setBlock({ ...block(), activity: { name: "Ran", detail: "command-6" }, children: [], totalToolCount: 6 })
    } })
    const updated = frame.split("\n").filter((line) => line.includes("└"))
    expect(updated).toHaveLength(1)
    expect(updated.join("\n")).not.toContain("command-2")
    expect(updated.join("\n")).not.toContain("command-5")
    expect(updated.join("\n")).toContain("command-6")
  })

  it("opens a linked running subagent from its header or agent line without a disclosure cue", async () => {
    const block: AgentGroupBlockType = {
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 6,
      label: "Explorer",
      description: "Trace rendering",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      children: Array.from({ length: 6 }, (_, index) => exec(`command-${index + 1}`, "")),
      linkUri: "flywheel://session/child-1",
      timestamp: Date.now(),
    }
    const navigated: string[] = []
    const options = { navigateUri: (uri: string) => navigated.push(uri) }

    const headerClick = await renderToolGroup(block, { ...options, click: { x: 4, y: 0 } })
    const previewClick = await renderToolGroup(block, { ...options, click: { x: 4, y: 1 } })

    expect(headerClick).toContain("↗ Open")
    expect(headerClick).not.toContain("show all")
    expect(headerClick).not.toContain("show less")
    expect(headerClick).not.toContain("▸")
    expect(headerClick).not.toContain("▾")
    expect(previewClick.split("\n").filter((line) => line.includes("└"))).toHaveLength(1)
    expect(navigated).toEqual(["flywheel://session/child-1", "flywheel://session/child-1"])
  })

  it("keeps the open cue after a linked subagent settles without showing its activity preview", async () => {
    const navigated: string[] = []
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 1,
      label: "Explorer",
      description: "Trace rendering",
      status: "completed",
      children: [exec("bun run test", "")],
      linkUri: "flywheel://session/child-1",
      duration: 10,
      timestamp: 0,
    }, {
      click: { x: 4, y: 0 },
      navigateUri: (uri) => navigated.push(uri),
    })

    expect(frame).toContain("↗ Open")
    expect(frame).not.toContain("bun run test")
    expect(frame).not.toContain("▸")
    expect(frame).not.toContain("▾")
    expect(navigated).toEqual(["flywheel://session/child-1"])
  })

  it("keeps children compact: bash output is never expandable inside a subagent box", async () => {
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 1,
      label: "Explorer",
      description: "Trace rendering",
      status: "active",
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      children: [exec("bun run test", "secret output line")],
      activity: { name: "Ran", detail: "bun run test" },
      timestamp: Date.now(),
    })

    expect(frame).toContain("bun run test")
    expect(frame).not.toContain("▸")
    expect(frame).not.toContain("secret output line")
  })

  it("shows the linked child's current model and effort", async () => {
    const [roles, setRoles] = createSignal<RoleAssignmentView>()
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 0,
      label: "General",
      description: "Own public output settlement",
      status: "active",
      children: [],
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      timestamp: Date.now(),
    }, {
      roleView: roles,
      updateAfterFirstRender: (initial) => {
        expect(initial).toContain("gpt-6-astra high")
        setRoles({ assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "gpt-6-astra", effort: "medium" } } })
      },
    })

    expect(frame).toContain("gpt-6-astra medium")
    expect(frame).not.toContain("gpt-6-astra high")
  })

  const workflowCard = (state: "active" | "paused" | "error", card: AgentGroupBlockType["card"]): AgentGroupBlockType => {
    const base: Omit<AgentGroupBlockType, "status"> = {
      kind: "agentGroup", containerKind: "workflow", id: "workflow-1", toolUseId: "tu-workflow", totalToolCount: 50, totalTokens: 40_100,
      label: "Fanout Ui", description: "Fanout UI", children: [read("src/a.ts")], linkUri: "flywheel://workflow/workflow-session", timestamp: Date.now(),
      duration: 571_000, ...(card === undefined ? {} : { card }),
    }
    if (state === "paused") return { ...base, status: "paused", pausedBy: "person" }
    if (state === "error") return { ...base, status: "error", failure: { title: "Workflow failed", message: "Workflow failed", guidance: "" } }
    return { ...base, status: "active" }
  }
  const cardOf = (fixture: FanoutFixture, settled: boolean, cut?: string) => foldWorkflowCard(timedFanoutOutline(fixture, cut), { settled })
  const boxWidth = (frame: string) => displayWidth(frame.split("\n").find((line) => line.includes("╭"))?.trim() ?? "")

  it.each([100, 60])("draws a running workflow's phases with their chits, its running phases' agents, and its plan bar in place of its tool rows at %i columns", async (width) => {
    const frame = await renderToolGroup(workflowCard("active", cardOf(FANOUT.lanes, false)), {
      width,
      roleView: () => ({ assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "claude-opus-5.5", effort: "medium" } } }),
      inspectSpans: (spans) => {
        expect(sameColor(spanColor(spans, "⚙")!, resolvedTheme.accent)).toBe(true)
        expect(sameColor(spanColor(spans, "▰")!, resolvedTheme.success)).toBe(true)
        expect(sameColor(spanColor(spans, "▱")!, resolvedTheme.borderSubtle)).toBe(true)
        // A phase's name and an agent's name each keep their own colour,
        // which no state uses.
        expect(sameColor(spanColor(spans, "probe")!, resolvedTheme.phaseName)).toBe(true)
        expect(sameColor(spanColor(spans, "api")!, resolvedTheme.agentName)).toBe(true)
        // A phase of named agents that has not started names its agents in
        // the same colour, with muted commas between them.
        const gates = spans.lines.find((line) => line.spans.map(({ text }) => text).join("").includes("○ gates"))?.spans ?? []
        const named = (text: string) => gates.find((span) => span.text === text)?.fg
        if (width === 100) {
          expect(sameColor(named("lint")!, resolvedTheme.agentName)).toBe(true)
          expect(sameColor(named("typecheck")!, resolvedTheme.agentName)).toBe(true)
          expect(sameColor(named(" · ")!, resolvedTheme.textMuted)).toBe(true)
        }
      },
    })
    expect(boxWidth(frame)).toBe(Math.min(width - 2, 100))
    if (width === 100) expect(frame).toMatch(/○ gates ▱▱ +0\/2 · lint · typecheck/)
    expect(frame).toContain("⚙ Fanout Ui")
    expect(frame).not.toContain("tokens")
    expect(frame).toMatch(/● probe +▰▰▰ .* 2\/3 /)
    expect(frame).toMatch(/● check +▰▰▱ .* 0\/3 /)
    expect(frame).toMatch(/├ ● api/)
    expect(frame).toMatch(/└ ○ api +waiting for its probe/)
    expect(frame).toContain(width === 100 ? "3/11 done · 3 running" : "3/11 · 3 running")
    for (const absent of ["operations", "claude-opus-5.5", "a.ts", "Fanout UI"]) expect(frame).not.toContain(absent)
  })

  it.each([100, 60])("reads every agent an interrupt holds as parked, in the warning colour, at %i columns", async (width) => {
    const frame = await renderToolGroup(workflowCard("paused", cardOf(FANOUT.reviews, false, "interrupted")), {
      width,
      inspectSpans: (spans) => {
        expect(sameColor(spanColor(spans, "Interrupted")!, resolvedTheme.warning)).toBe(true)
        expect(sameColor(spanColor(spans, "‖")!, resolvedTheme.warning)).toBe(true)
      },
    })
    // The state and the time never drop: the label gives up its width first.
    expect(frame).toContain("Interrupted · 9m 31s")
    expect(frame).toContain(width === 100 ? "10/24 done · 11 interrupted" : "10/24 · 11 interrupted")
    expect(frame).toMatch(/‖ review +▰+ .* 3\/14 /)
    expect(frame).toMatch(/├ ‖ config\.ts +interrupted/)
    expect(frame).toMatch(/└ \+8 more · 3 done · 5 interrupted/)
  })

  // A chat that opens with an interrupted run in it draws the card's
  // header controls from the held row on its first frame.
  it("draws Resume and Stop on the header of an interrupted card whose row the shell already holds", async () => {
    const row = workflowDetail({ workflowId: "workflow-session", admittedActions: ["workflow.resume", "workflow.stop", "workflow.delete"] })
    const empty = () => new Set<string>()
    const processControls: RowProcessControls = { activeHeldToolCallIds: empty, activeManagedProcessToolCallIds: empty, processorHeldToolCallIds: empty, onDetach: () => {}, onStop: () => {}, onStopChild: () => {} }
    const frame = await renderToolGroup(workflowCard("paused", cardOf(FANOUT.reviews, false, "interrupted")), { width: 100, cards: { row: () => row }, processControls })
    expect(frame).toMatch(/Interrupted · 9m 31s\s+resume\s+stop/)
    expect(frame).not.toContain("tokens")
  })

  // A hold that drops empties its cache until a fresh read lands, so the
  // card's live activity and Interrupt would vanish for a moment.
  it("keeps a running card's holds across a token update and drops them once the run completes", async () => {
    const running = workflowCard("active", cardOf(FANOUT.lanes, false))
    const holdsAfter = async (next: AgentGroupBlockType) => {
      const counts = { follows: 0, followReleases: 0, holds: 0, holdReleases: 0 }
      const [block, setBlock] = createSignal(running)
      let settled: typeof counts | undefined
      await renderToolGroup(running, {
        block,
        cards: {
          follow: () => { counts.follows += 1; return { release: () => { counts.followReleases += 1 } } },
          hold: () => { counts.holds += 1; return { release: () => { counts.holdReleases += 1 } } },
        },
        updateAfterFirstRender: () => setBlock(next),
        inspectSpans: () => { settled = { ...counts } },
      })
      return settled
    }
    expect(await holdsAfter({ ...running, totalTokens: 41_200 })).toEqual({ follows: 1, followReleases: 0, holds: 1, holdReleases: 0 })
    expect(await holdsAfter({ ...running, status: "completed", card: cardOf(FANOUT.lanes, true) })).toEqual({ follows: 1, followReleases: 1, holds: 1, holdReleases: 1 })
  })

  it("states in place of the plan why saved progress that cannot run waits, beside the header's Restart", async () => {
    const row = workflowDetail({ workflowId: "workflow-session", admittedActions: ["workflow.restart", "workflow.stop", "workflow.delete"], readability: "unavailable" })
    const frame = await renderToolGroup(workflowCard("active", undefined), { width: 100, cards: { row: () => row } })
    expect(frame).toMatch(/restart/)
    expect(frame).toMatch(/This workflow's saved progress cannot run\. Restart runs it again from\s+its recorded request\./)
  })

  it.each([40, 34])("draws no box at %i columns: the bar with its short count, the plan folded around the phase that needs attention, and its agents", async (width) => {
    const running = await renderToolGroup(workflowCard("active", cardOf(FANOUT.reviews, false)), { width })
    expect(running).toContain("10/24 · 11 running")
    const frame = await renderToolGroup(workflowCard("paused", cardOf(FANOUT.reviews, false, "interrupted")), { width })
    expect(frame).not.toContain("╭")
    // The state and the time never drop: the label gives up its width first.
    expect(frame).toContain("Interrupted · 9m 31s")
    // A label that does not fit drops whole parts, the interrupted units first, and never cuts a word.
    expect(frame).toMatch(width === 40 ? /▱ {2}10\/24 · 11 interrupted *$/m : /▱ {2}10\/24 *$/m)
    expect(frame).toContain("✓ 3 done › ‖ review › 2 more")
    expect(frame).toMatch(/^ {2}▰{6} 3\/14 · 11 interr/m)
    expect(frame).toMatch(/^ {2}├ ‖ config\.ts *$/m)
  })

  it.each([100, 60])("says what each phase of a failed run did, the failure in the error colour, at %i columns", async (width) => {
    const frame = await renderToolGroup(workflowCard("error", cardOf(FANOUT_FAILED, true)), {
      width,
      inspectSpans: (spans) => {
        expect(sameColor(spanColor(spans, "Failed")!, resolvedTheme.error)).toBe(true)
        expect(sameColor(spanColor(spans, "Collected 13 results")!, resolvedTheme.error)).toBe(true)
        expect(sameColor(spanColor(spans, "✗")!, resolvedTheme.error)).toBe(true)
        expect(sameColor(spanColor(spans, "Collected 3 results")!, resolvedTheme.textMuted)).toBe(true)
      },
    })
    expect(frame).toMatch(/✓ scout +The wait command exited 0.* 3m 4s │/)
    // A settled phase with a failed agent keeps that agent's line.
    expect(frame).toMatch(/└ ✗ db\.ts +the step ended without a/)
    expect(frame).toMatch(/– gates +0\/2 · skipped/)
    expect(frame).toMatch(/23\/24( done)? · 1 failed/)
    expect(frame).not.toContain("Workflow failed")
  })

  // T4 to T7: a phase of 14 reviewers with one failed agent. Width never
  // changes how many lines the card has.
  it.each([100, 60])("draws a running phase's agents as a tree under its chits, the failed agent first, at %i columns", async (width) => {
    const chits = { review: "", bar: "" }
    const frame = await renderToolGroup(workflowCard("active", cardOf(FANOUT.reviewsFailing, false)), {
      width,
      inspectSpans: (spans) => {
        expect(sameColor(spanColor(spans, "✗")!, resolvedTheme.error)).toBe(true)
        expect(sameColor(spanColor(spans, "▱")!, resolvedTheme.borderSubtle)).toBe(true)
      },
    })
    const rows = frame.split("\n")
    const box = rows.filter((line) => line.includes("│") || line.includes("╭") || line.includes("╰"))
    expect(boxWidth(frame)).toBe(Math.min(width - 2, 100))
    expect(box).toHaveLength(16)
    chits.review = /● review +([▰▱]+)/.exec(frame)?.[1] ?? ""
    chits.bar = /│ ([▰▱]+) {2}9\/24/.exec(frame)?.[1] ?? ""
    // 12 phase slots and 30 bar slots in a box of 80 columns or more, 8 and 20 below.
    expect(chits.review).toBe(width === 100 ? "▰".repeat(12) : "▰".repeat(8))
    expect(chits.bar).toBe(width === 100 ? `${"▰".repeat(21)}▱▱▱` : `${"▰".repeat(18)}▱▱`)
    expect(frame).toMatch(/├ ✗ db\.ts +Type check failed: db\.t/)
    expect(frame).toMatch(/├ ● cache\.ts/)
    expect(frame).toMatch(/└ \+8 more · 2 done · 6 running/)
    expect(rows.filter((line) => /[├└]/.test(line))).toHaveLength(7)
    // A settled phase keeps its chits after its id, then its count and result.
    expect(frame).toMatch(/✓ check ▰▰▰ +3\/3 · Collected 3 results/)
    expect(frame).toContain(width === 100 ? "9/24 done · 11 running · 1 failed" : "9/24 · 11 running · 1 failed")
  })

  it("draws the same run below 46 columns with no box: the bar, the folded plan, the phase's chits and count, and its agents", async () => {
    const frame = await renderToolGroup(workflowCard("active", cardOf(FANOUT.reviewsFailing, false)), { width: 40 })
    expect(frame).not.toContain("╭")
    const rows = frame.split("\n").map((line) => line.trimEnd())
    // A bar too narrow for every word drops the running units, which its
    // chits colour, before it would cut a word.
    expect(rows[1]).toBe(`  ${"▰".repeat(11)}▱  9/24 · 1 failed`)
    expect(rows[2]).toBe("  ✓ 3 done › ● review › 2 more")
    expect(rows[3]).toMatch(/^ {2}▰{6} 2\/14 · 11 running · /)
    expect(rows[4]).toMatch(/^ {2}├ ✗ db\.ts +40s$/)
    expect(rows[10]).toBe("  └ +8 more · 2 done · 6 running")
  })

  it("opens a named agent of the card in its own view over the chat", async () => {
    const opened: unknown[] = []
    const openAgent: WorkflowCards["openAgent"] = (sessionId, agent) => opened.push([sessionId, agent])
    const frame = await renderToolGroup(workflowCard("active", cardOf(FANOUT.lanes, false)), { width: 100, openAgent })
    const rows = frame.split("\n")
    const y = rows.findIndex((line) => line.includes("● api"))
    const x = rows[y]!.indexOf("● api") + 2
    await renderToolGroup(workflowCard("active", cardOf(FANOUT.lanes, false)), { width: 100, openAgent, click: { x, y } })
    expect(opened).toEqual([["workflow-session", { kind: "agent", agentNodeId: "lanes:1:probe", state: "running" }]])
  })

  it("opens the agent of a phase of one agent from its line on the inline card", async () => {
    const opened: unknown[] = []
    const openAgent: WorkflowCards["openAgent"] = (sessionId, agent) => opened.push([sessionId, agent])
    const navigated: string[] = []
    const options = { width: 100, openAgent, navigateUri: (uri: string) => navigated.push(uri) }
    const block = workflowCard("active", cardOf(FANOUT.scout, false))
    const rows = (await renderToolGroup(block, options)).split("\n")
    const y = rows.findIndex((line) => line.includes("● scout"))
    await renderToolGroup(block, { ...options, click: { x: rows[y]!.indexOf("● scout") + 3, y } })
    expect(opened).toEqual([["workflow-session", { kind: "agent", agentNodeId: "scout", state: "running" }]])
    expect(navigated).toEqual([])
  })

  it("opens the workflow from its header's text and its drawn box, never from the blank space beside them", async () => {
    const navigated: string[] = []
    const options = { width: 140, navigateUri: (uri: string) => navigated.push(uri) }
    const block = workflowCard("active", cardOf(FANOUT.lanes, false))
    const rows = (await renderToolGroup(block, options)).split("\n")
    const top = rows.findIndex((line) => line.includes("╭"))
    const corner = rows[top]!.lastIndexOf("╮")
    expect(corner).toBeLessThan(120)
    for (const click of [{ x: rows[0]!.trimEnd().length + 2, y: 0 }, { x: corner + 2, y: top }, { x: corner + 2, y: top + 1 }]) {
      await renderToolGroup(block, { ...options, click })
    }
    expect(navigated).toEqual([])
    for (const click of [{ x: rows[0]!.indexOf("Fanout"), y: 0 }, { x: corner, y: top }]) await renderToolGroup(block, { ...options, click })
    expect(navigated).toEqual(["flywheel://workflow/workflow-session", "flywheel://workflow/workflow-session"])
  })

  it("opens a failed child from its failure detail's glyphs, never from blank or clipped space after them", async () => {
    const navigated: string[] = []
    const options = { width: 40, navigateUri: (uri: string) => navigated.push(uri) }
    // A detail wider than the row draws only its start; a trailing no-break space
    // is blank; a wide glyph with one column left before the edge is not drawn.
    const details: [string, string, (x: number) => number[]][] = [
      [`qqq${" ".repeat(60)}zzz`, "zzz", (x) => [x + 3, x + 5, 38]],
      ["qqq\u00a0\u00a0\u00a0", "zzz", (x) => [x + 3, x + 5, 38]],
      [`qqq${"q".repeat(34)}\u6f22`, "\u6f22", () => [39]],
    ]
    for (const [detail, clippedGlyph, blanks] of details) {
      const failure = { title: "Provider request failed", message: "The provider rejected the request.", guidance: "", detail }
      const block: AgentGroupBlockType = { kind: "agentGroup", containerKind: "subagent", id: "agent-1", toolUseId: "tu-agent-1", totalToolCount: 0, label: "General", description: "Provider request failed", status: "error", children: [], failure, linkUri: "flywheel://session/child-1", timestamp: Date.now() }
      const rows = (await renderToolGroup(block, options)).split("\n")
      const y = rows.findIndex((line) => line.includes("qqq"))
      const x = rows[y]!.indexOf("qqq")
      for (const blank of blanks(x)) await renderToolGroup(block, { ...options, click: { x: blank, y } })
      expect({ clipped: rows[y]!.includes(clippedGlyph), navigated: navigated.splice(0) }).toEqual({ clipped: false, navigated: [] })
      await renderToolGroup(block, { ...options, click: { x: x + 1, y } })
      expect(navigated.splice(0)).toEqual(["flywheel://session/child-1"])
    }
  })

  it("right-aligns a narrow workflow card's controls line and opens it from the arrow, never from the blank before it", async () => {
    const navigated: string[] = []
    const options = { width: 40, navigateUri: (uri: string) => navigated.push(uri) }
    const block = workflowCard("active", cardOf(FANOUT.lanes, false))
    const rows = (await renderToolGroup(block, options)).split("\n")
    const y = rows.findIndex((line) => /^ +↗$/.test(line))
    expect(rows[y]!.indexOf("↗")).toBe(39)
    for (const x of [29, 37, 38]) await renderToolGroup(block, { ...options, click: { x, y } })
    expect(navigated.splice(0)).toEqual([])
    await renderToolGroup(block, { ...options, click: { x: 39, y } })
    expect(navigated).toEqual(["flywheel://workflow/workflow-session"])
  })

  it("keeps the current assignment visible on a linked error card", async () => {
    const frame = await renderToolGroup({
      kind: "agentGroup",
      containerKind: "subagent",
      id: "agent-1",
      toolUseId: "tu-agent-1",
      totalToolCount: 0,
      label: "General",
      description: "Provider request failed",
      status: "error",
      children: [],
      failure: {
        title: "Provider request failed",
        message: "The provider rejected the request.",
        guidance: "Retry after checking the provider.",
        detail: "Provider error",
      },
      model: "gpt-6-astra high",
      linkUri: "flywheel://session/child-1",
      timestamp: Date.now(),
    }, {
      roleView: () => ({ assignments: {}, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "gpt-6-astra", effort: "medium" } } }),
    })

    expect(frame).toContain("Provider request failed")
    expect(frame).toContain("gpt-6-astra medium")
  })
})