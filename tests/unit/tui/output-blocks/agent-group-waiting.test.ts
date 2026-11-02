import { expect, it } from "bun:test"
import type { AgentGroupBlock as AgentGroupBlockType } from "../../../../src/infra/output-blocks.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"

// A child that waits on a reply says so on its card, so the person sees
// which session holds it up without opening the child.
it.each(["subagent", "workflow"] as const)("a running %s card names the session its child waits on, and a settled card does not", async (containerKind) => {
  const [{ testRender }, { createComponent }, { createSignal }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("solid-js"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const running: AgentGroupBlockType = {
    kind: "agentGroup",
    containerKind,
    id: "child-row",
    toolUseId: "child-call",
    totalToolCount: 0,
    label: "Spec",
    description: "Write the spec",
    status: "active",
    model: "gpt-6-astra high",
    activeStartedAt: Date.now(),
    linkUri: "flywheel://session/child-session",
    children: [],
    timestamp: Date.now(),
  }
  const [block, setBlock] = createSignal(running)
  const asked: string[] = []
  const result = await testRender(
    () =>
      createComponent(TickPoolProvider, {
        get children() {
          return createComponent(ThemeProvider, {
            mode: "dark",
            get children() {
              return createComponent(BlockRenderer, {
                get block() { return terminalTranscript([block()], false).timelineBlocks[0]! },
                childStatus: (sessionId: string) => {
                  asked.push(sessionId)
                  return { waitingOn: "Waiting on parent" }
                },
              })
            },
          })
        },
      }),
    { width: 80, height: 6 },
  )
  try {
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("Waiting on parent")
    expect(asked).toContain("child-session")

    setBlock({ ...running, status: "completed" })
    await result.renderOnce()
    expect(result.captureCharFrame()).not.toContain("Waiting on parent")
  } finally {
    result.renderer.destroy()
  }
})

