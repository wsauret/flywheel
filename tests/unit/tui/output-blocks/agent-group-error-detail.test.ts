import { describe, expect, it } from "bun:test"
import type { CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import type { AgentGroupBlock as AgentGroupBlockType } from "../../../../src/infra/output-blocks.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { STRIKETHROUGH } from "../../../../src/tui/utils/text-attributes.js"

const theme = resolveTheme(flywheelThemeJson, "dark")
const LONG = "The OpenAI API key was rejected because the configured credential is invalid."

async function renderErrorBlock(width: number, detail?: string): Promise<{ text: string; spans: CapturedFrame }> {
  const [{ AgentGroupBlock }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/output-blocks/agent-group-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])

  const block: AgentGroupBlockType = {
    kind: "agentGroup",
    id: "a1",
    containerKind: "subagent",
    toolUseId: "tu-a1",
    totalToolCount: 0,
    label: "Explorer",
    description: "Trace tab bar rendering",
    status: "error",
    children: [],
    failure: {
      title: "Authentication failed",
      message: LONG,
      guidance: "Run /auth to replace the credential, then retry.",
      ...(detail ? { detail } : {}),
      action: { label: "Manage credentials", command: "/auth" },
    },
    timestamp: Date.now(),
  }

  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(AgentGroupBlock, { block })
            },
          })
        },
      }),
    { width, height: 12 },
  )
  try {
    await result.renderOnce()
    return { text: result.captureCharFrame(), spans: result.captureSpans() }
  } finally {
    result.renderer.destroy()
  }
}

async function renderAgentBlock(status: Exclude<AgentGroupBlockType["status"], "error" | "paused">): Promise<CapturedFrame> {
  const [{ AgentGroupBlock }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/output-blocks/agent-group-block.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])

  const block: AgentGroupBlockType = {
    kind: "agentGroup",
    id: "a1",
    containerKind: "subagent",
    toolUseId: "tu-a1",
    totalToolCount: 1,
    label: "Explorer",
    description: "Trace tab bar rendering",
    status,
    children: [{
      kind: "tool",
      id: "t1",
      name: "read",
      presentation: { name: "Read", detail: "src/index.ts" },
      status: "pending",
      timestamp: Date.now(),
    }],
    timestamp: Date.now(),
  }

  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(AgentGroupBlock, { block })
            },
          })
        },
      }),
    { width: 80, height: 12 },
  )
  try {
    await result.renderOnce()
    return result.captureSpans()
  } finally {
    result.renderer.destroy()
  }
}

function spanContaining(frame: CapturedFrame, text: string) {
  return frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))
}

function hasSpan(frame: CapturedFrame, text: string): boolean {
  return frame.lines.some((line) => line.spans.some((span) => span.text.includes(text)))
}

function hasStruckSpan(frame: CapturedFrame, text: string): boolean {
  return frame.lines.some((line) =>
    line.spans.some((span) => span.text.includes(text) && ((span.attributes & STRIKETHROUGH) === STRIKETHROUGH))
  )
}

describe("AgentGroupBlock error detail", () => {
  it("renders the short message, then the provider detail in a quieter color, under one gutter without generic advice", async () => {
    const { text, spans } = await renderErrorBlock(90, "Provider overloaded: capacity exhausted")
    expect(text).toMatch(/└ ✗ The OpenAI API key was rejected[^\n]*\n\s+Provider overloaded: capacity exhausted/)
    expect(spanContaining(spans, "The OpenAI API key")?.fg.equals(theme.error)).toBe(true)
    expect(spanContaining(spans, "Provider overloaded")?.fg.equals(theme.textMuted)).toBe(true)
    expect(text).not.toContain("Authentication failed")
    expect(text).not.toContain("Run /auth")
    expect(text).not.toMatch(/⎿[\s\S]*⎿/)
  })

  it("cuts the failure sentence to one agent line within the available width", async () => {
    const narrow = (await renderErrorBlock(50)).text
    const wide = (await renderErrorBlock(72)).text
    expect(narrow).toMatch(/└ ✗ The OpenAI API key was rejected because.*…/)
    expect(wide).toContain("The OpenAI API key was rejected because the configured")
  })
})

describe("ToolGroupBlock interrupted styling", () => {
  it("keeps the persona plain and names interruption in the agent line", async () => {
    const frame = await renderAgentBlock("interrupted")

    expect(hasStruckSpan(frame, "Explorer")).toBe(false)
    expect(hasSpan(frame, "‖")).toBe(true)
    expect(hasSpan(frame, "Interrupted")).toBe(true)
    expect(hasSpan(frame, "Read")).toBe(false)
    expect(hasSpan(frame, "index.ts")).toBe(false)
  })

})
