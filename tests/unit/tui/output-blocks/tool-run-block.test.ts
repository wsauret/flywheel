import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { Schema } from "effect"
import { AnyBlockSchema, type ToolEntry } from "../../../../src/infra/output-blocks.js"
import { getToolDisplay, resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import type { ToolRun, ToolRunStatus } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { presentTerminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"
import { foldTranscript } from "../../../../src/protocol/client/transcript-model.js"

const CWD = "/workspace"

/** Rows are built the way the projectors build them: raw machine name plus the
 *  resolver's canonical presentation, so no expectation can drift from
 *  production rendering. */
interface ToolInput {
  readonly [key: string]: unknown
}

const isBlock = Schema.is(AnyBlockSchema)

/** A row with `extra` laid over it. The overrides can mix status variants,
 *  so the row is checked against the block schema it must satisfy. */
function row(
  name: string,
  input: ToolInput,
  status: ToolEntry["status"] = "completed",
  extra: Partial<ToolEntry> = {},
): ToolEntry {
  const entry = {
    kind: "tool",
    id: `${name}-${JSON.stringify(input)}`,
    name,
    presentation: resolveToolPresentation(name, input, CWD),
    action: getToolDisplay(name).action,
    timestamp: 0,
    status,
    ...extra,
  }
  if (!isBlock(entry) || entry.kind !== "tool") throw new Error(`fixture row ${entry.id} is not a valid tool entry`)
  return entry
}

const read = (path: string, status: ToolEntry["status"] = "completed"): ToolEntry =>
  row("read", { path: `${CWD}/${path}` }, status, { linkUri: `file://${CWD}/${path}` })
const search = (pattern: string, path: string): ToolEntry => row("search", { pattern, path })
const exec = (command: string, extra: Partial<ToolEntry> = {}): ToolEntry => row("bash", { command }, "completed", extra)
const execute = (name: string, detail: string, content = ""): ToolEntry => row(name, {}, "completed", { presentation: { name, detail }, runCategoryOverride: "execute", content })
const loadSkill = (skillId: string, status: ToolEntry["status"] = "completed", extra: Partial<ToolEntry> = {}): ToolEntry =>
  row("skill", { action: "load", skill_id: skillId }, status, extra)
const readResource = (skillId: string, path: string): ToolEntry =>
  row("skill", { action: "resource", skill_id: skillId, path })

function toolRun(children: ToolEntry[], status: ToolRunStatus, duration?: number): ToolRun {
  const category = children[0]?.runCategoryOverride ?? (children[0]?.name === "bash" ? "exec" : "explore")
  return {
    kind: "toolRun",
    id: "tools:run:0:0",
    category,
    status,
    children,
    timestamp: 0,
    ...(duration !== undefined ? { duration } : {}),
  }
}

async function renderToolRun(block: ToolRun, expandAtY?: number, width = 100, onHydrateBody?: (id: string) => void): Promise<string> {
  const [{ ToolRunBlock }, { ThemeProvider }, { TickPoolProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }] = await Promise.all([
    import("../../../../src/tui/output-blocks/tool-run-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
  ])

  const result = await testRender(
    () =>
      createComponent(BlockDisclosureProvider, {
        value: createBlockDisclosureChannel(),
        get children() {
          return createComponent(TickPoolProvider, {
            get children() {
              return createComponent(ThemeProvider, {
                mode: "dark",
                get children() {
                  return createComponent(ToolRunBlock, { block, onHydrateBody })
                },
              })
            },
          })
        },
      }),
    { width, height: 14 },
  )

  try {
    await result.renderOnce()
    // Multi-line rows need a second pass: the first layout measures the list
    // width, the second re-lays-out rows whose content grew taller.
    await result.renderOnce()
    if (expandAtY !== undefined) {
      await result.mockMouse.click(8, expandAtY)
      await result.mockMouse.moveTo(99, 13)
      await result.renderOnce()
      await result.renderOnce()
    }
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}

describe("ToolRunBlock", () => {
  it("renders received message disclosures inside Ran with shell rows on both sides", async () => {
    const transcript = presentTerminalTranscript(foldTranscript([
      exec("echo before"),
      { kind: "userMessage", id: "message", content: "Use main.ts", timestamp: 2, pending: false, injected: false,
        from: { sessionId: "sender", name: "Sender", relation: "sibling", personWords: "Keep tests green" } },
      exec("echo after"),
    ], false))
    expect(transcript.timelineBlocks).toHaveLength(1)
    const block = transcript.timelineBlocks[0]
    if (block?.kind !== "toolRun") throw new Error("expected a Ran group")
    const closed = await renderToolRun(block)
    expect(closed).toContain("Ran")
    expect(closed).toContain("Message from Sender")
    expect(closed).not.toContain("Use main.ts")
    const messageY = closed.split("\n").findIndex(line => line.includes("Message from Sender"))
    const open = await renderToolRun(block, messageY)
    expect(open).toContain("Use main.ts")
    expect(open.split("\n").find(line => line.includes("Use main.ts"))?.trimStart()).toMatch(/^│ +Use main.ts/)
    expect(open).toContain("Keep tests green")
    expect(open.indexOf("echo before")).toBeLessThan(open.indexOf("Use main.ts"))
    expect(open.indexOf("Use main.ts")).toBeLessThan(open.indexOf("echo after"))
  })
  it("keeps the direction on wait-only sends and hydrates omitted sent text on expansion", async () => {
    const wait = row("message_session", { to: "parent", wait: true })
    const closedWait = await renderToolRun({ ...toolRun([wait], "completed"), category: "exec" })
    expect(closedWait).toContain("Message to")
    const sent = { ...wait, id: "sent", invocationBodyOmittedBytes: 25 }
    const block = { ...toolRun([sent], "completed"), category: "exec" as const }
    const closed = await renderToolRun(block)
    expect(closed).toContain("▸")
    const messageY = closed.split("\n").findIndex(line => line.includes("Message to"))
    const requests: string[] = []
    await renderToolRun(block, messageY, 100, id => requests.push(id))
    expect(requests).toEqual(["tool:sent"])
  })
  it("shows a Bash row as its command alone and names every other tool in Ran", async () => {
    const block = { ...toolRun([exec("echo hi"), row("run_experiment", {}), row("ios_simulator", { workflow: "simulator", action: "list" })], "completed"), category: "exec" as const }
    const frame = await renderToolRun(block)
    expect(frame).not.toContain("Bash")
    expect(frame).toContain("Run Experiment")
    expect(frame).toContain("iOS Simulator simulator list")
  })
  it("names an override row by its relative path and discloses the diff it returned", async () => {
    const diff = row("definition_overrides", { action: "diff", path: `${CWD}/.flywheel/personas/reviewer.md` }, "completed", { content: "- old line\n+ new line" })
    const block = { ...toolRun([exec("echo hi"), diff], "completed"), category: "exec" as const }
    const closed = await renderToolRun(block)
    expect(closed).toContain("Definition Overrides diff .flywheel/personas/reviewer.md ▸")
    const open = await renderToolRun(block, closed.split("\n").findIndex(line => line.includes("Definition Overrides")))
    expect(open).toContain("+ new line")
  })
  it("marks an unfinished run active without a settled duration", async () => {
    const frame = await renderToolRun(toolRun([exec("bun run build", { status: "pending" })], "active", 1200))
    expect(frame).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(frame).toContain("Ran")
    expect(frame).not.toContain("1.2s")
  })

  it("renders explore runs with an Explored heading, duration, and merged read rows", async () => {
    const frame = await renderToolRun(toolRun([read("src/a.ts"), read("src/b.ts")], "completed", 2000))

    expect(frame).toContain("Explored · 2.0s")
    expect(frame).toContain("└ Read a.ts, b.ts")
  })

  it("renders consecutive skill loads as one comma-separated explore row under one canonical name", async () => {
    const frame = await renderToolRun(toolRun([
      loadSkill("implementation"),
      loadSkill("typescript-bun"),
      loadSkill("solid-reactivity"),
    ], "completed"))

    expect(frame).toContain("Explored")
    expect(frame).toContain("└ Load Skill implementation, typescript-bun, solid-reactivity")
    expect(frame.match(/Load Skill/g)).toHaveLength(1)
  })

  it("keeps a failed skill load on its canonical name and appends the error", async () => {
    const frame = await renderToolRun(toolRun([loadSkill("missing-skill", "error", { errorMessage: "Skill not found" })], "completed"))

    expect(frame).toContain("└ Load Skill missing-skill Skill not found")
    expect(frame).not.toContain("Failed to load")
  })

  it("keeps full identifiers for grouped skill resources", async () => {
    const frame = await renderToolRun(toolRun([
      readResource("alpha", "references/config.md"),
      readResource("beta", "templates/config.md"),
    ], "completed"))

    expect(frame).toContain("└ Read Skill Resource alpha/references/config.md, beta/templates/config.md")
  })

  it("never merges a skill load into an adjacent resource read", async () => {
    const frame = await renderToolRun(toolRun([
      loadSkill("implementation"),
      readResource("implementation", "references/guide.md"),
    ], "completed"))

    expect(frame).toContain("├ Load Skill implementation")
    expect(frame).toContain("└ Read Skill Resource implementation/references/guide.md")
  })

  it("marks every row of a multi-row explore run with tree connectors", async () => {
    const frame = await renderToolRun(toolRun([search("a", "src"), search("b", "src")], "completed", 2000))

    expect(frame).toContain("├ Search \"a\" in src")
    expect(frame).toContain("└ Search \"b\" in src")
  })

  it("renders exec runs with a Ran heading and verb-less command rows", async () => {
    const frame = await renderToolRun(toolRun([exec("seq 1 30")], "completed", 1000))

    expect(frame).toContain("Ran · 1.0s")
    expect(frame).toContain("└ seq 1 30")
    expect(frame).not.toContain("Bash seq")
  })

  it("states how long a background command ran under Ran, not how long its launch took", async () => {
    const transcript = presentTerminalTranscript(foldTranscript([
      exec("bun run test:perf", { timestamp: 1000, background: true, endedAt: 46_600 }),
      { kind: "text", id: "reply", content: "Started the perf run.", timestamp: 1865 },
    ], false))
    const block = transcript.timelineBlocks[0]
    if (block?.kind !== "toolRun") throw new Error("expected a Ran group")
    const frame = await renderToolRun(block)
    expect(frame).toContain("Ran · 45.6s")
    expect(frame).not.toContain("865ms")
  })

  it("renders execute children with labels, primitive summaries, rails, and expandable results", async () => {
    const frame = await renderToolRun(toolRun([
      execute("linear.get_issue", "[id=ENG-1, include=true]", "issue result"),
      execute("read", "[path=a.ts]", "file result"),
    ], "completed", 1000))
    expect(frame).toContain("Executed · 1.0s")
    expect(frame).toContain("├ linear.get_issue [id=ENG-1, include=true] ▸")
    expect(frame).toContain("└ read [path=a.ts] ▸")
    expect(frame).not.toContain("issue result")
  })

  for (const width of [40, 100]) {
    it(`caps Executed summaries at two displayed lines at width ${width}`, async () => {
      const detail = `[description=${"issue body\nwith more text ".repeat(100)}END]`
      const entry = execute("linear.save_issue", detail)
      const frame = await renderToolRun(toolRun([entry], "completed"), undefined, width)
      const lines = frame.split("\n").filter((line) => line.trim())
      expect(lines).toHaveLength(3)
      expect(lines[1]).toContain("linear.save_issue")
      expect(lines[2]).toContain("…")
      expect(frame).not.toContain("END")
      expect(entry.presentation.detail).toBe(detail)
    })
  }

  it("folds newlines in short Executed input without adding an ellipsis", async () => {
    const frame = await renderToolRun(toolRun([execute("linear.save_issue", "[description=one\n two]")], "completed"))
    expect(frame).toContain("[description=one two]")
    expect(frame).not.toContain("…")
  })

  it("preserves the output disclosure and its result when input is capped", async () => {
    const entry = execute("linear.save_issue", `[description=${"body ".repeat(100)}]`, "saved issue result")
    const collapsed = await renderToolRun(toolRun([entry], "completed"))
    expect(collapsed).toContain("… ▸")
    expect(collapsed.split("\n").filter((line) => line.trim())).toHaveLength(3)
    const expanded = await renderToolRun(toolRun([entry], "completed"), 1)
    expect(expanded).toContain("saved issue result")
    expect(expanded).toContain("… ▾")
  })

  it("renders a compact Papercut child and reveals its exact observation", async () => {
    const observation = "Observed repeated spacing failure in the transcript."
    const papercut = row("papercut_log", { observation }, "completed", {
      runCategoryOverride: "execute",
      invocationBody: { content: observation, filetype: "text", presentation: "disclosure" },
    })
    const collapsed = await renderToolRun(toolRun([papercut], "completed"))
    expect(collapsed).toContain("Executed")
    expect(collapsed).toContain("└ Papercut Observed repeated spacing failure in the transcript. ▸")
    expect(collapsed.match(/Observed repeated spacing failure in the transcript\./g)).toHaveLength(1)

    const expanded = await renderToolRun(toolRun([papercut], "completed"), 1)
    expect(expanded.match(/Observed repeated spacing failure in the transcript\./g)).toHaveLength(2)
  })

  it("gives every command in an exec run one logical row, railing a soft-wrapped continuation", async () => {
    // The presentation boundary folds a command to one logical line, so only
    // width wraps a row, and a wrap under a middle command keeps the rail.
    const frame = await renderToolRun(toolRun([
      exec("echo one"),
      exec("echo start\necho end"),
      exec(`echo ${"middle-argument ".repeat(8)}wrapped`),
      exec("echo last"),
    ], "completed", 1000))

    expect(frame).toContain("├ echo one")
    expect(frame).toContain("├ echo start echo end")
    expect(frame).not.toContain("│ echo end")
    expect(frame).toContain("├ echo middle-argument")
    expect(frame).toContain("│ middle-argument middle-argument middle-argument wrapped")
    expect(frame).toContain("└ echo last")
  })

  it("keeps the continuation rail when trailing output spaces wrap", async () => {
    const frame = await renderToolRun(toolRun([
      exec("printf output", { content: `${"x".repeat(90)}            \nafter` }),
      exec("echo next"),
    ], "completed"), 1)
    const lines = frame.split("\n")
    const afterLine = lines.findIndex((line) => line.includes("│ after"))

    expect(afterLine).toBeGreaterThan(-1)
    expect(lines[afterLine - 1]).toMatch(/^\s*│\s*$/)
  })

  it("keeps standalone exec rows expandable: bash output shows a disclosure chevron", async () => {
    const frame = await renderToolRun(toolRun([exec("echo hi", { content: "captured output line" })], "completed", 1000))

    expect(frame).toContain("└ echo hi ▸")
    expect(frame).not.toContain("captured output line")
  })

  it("labels paused runs Interrupted without a duration tail", async () => {
    const frame = await renderToolRun(toolRun([read("src/a.ts", "interrupted")], "paused"))

    expect(frame).toContain("Interrupted")
    expect(frame).not.toContain("·")
  })
})
