import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import type { RuntimeClient, RuntimeHealth, RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import { runtimeFaultCopy } from "../../../../src/protocol/client/runtime-fault-copy.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { tuiFaultNotice } from "../../../../src/tui/modules.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const theme = resolveTheme(flywheelTheme, "dark")

interface RenderedSpan { readonly text: string; readonly fg: { equals(other: unknown): boolean } }

/** Renders the shell's runtime notice for one health, as the shell places it
 *  above the composer, and returns its styled spans. */
async function renderNotice(health: Exclude<RuntimeHealth, { kind: "healthy" }>, copyReport = false): Promise<{ frame: string; spans: readonly RenderedSpan[]; copied: readonly string[]; queries: readonly RuntimeQuery[] }> {
  const [{ RuntimeNotice }, { ThemeProvider }] = await Promise.all([
    import("../../../../src/tui/components/runtime-notice.js"),
    import("../../../../src/tui/context/theme.js"),
  ])
  const copied: string[] = []
  const queries: RuntimeQuery[] = []
  const client: Pick<RuntimeClient, "query"> = { query: runtimeQuery({ "bugReport.failed": async (query) => { queries.push(query); return "account-assembled report" } }) }
  const notice = tuiFaultNotice(runtimeFaultCopy(health, "installed"), health, {
    client, clipboard: { copy: async (text) => { copied.push(text) } }, showToast() {},
  })
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() { return createComponent(RuntimeNotice, { notice, placement: "composer" }) },
    }),
    { width: 200, height: 8 },
  )
  try {
    await result.renderOnce()
    if (copyReport) {
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Copy report"))
      expect(y).toBeGreaterThanOrEqual(0)
      await result.mockMouse.click(lines[y]!.indexOf("Copy report") + 1, y)
      await Bun.sleep(0)
    }
    return { frame: result.captureCharFrame(), spans: result.captureSpans().lines.flatMap((line) => line.spans), copied, queries }
  } finally {
    result.renderer.destroy()
  }
}

describe("RuntimeNotice", () => {
  it("renders a process Flywheel is restarting in the warning color, with no reset to run", async () => {
    const { frame, spans } = await renderNotice({ kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" })
    expect(frame).toContain("Flywheel's process for this project stopped again. Last cause: stopped by signal SIGKILL.")
    expect(frame).not.toContain("flywheel kill")
    expect(spans.find((span) => span.text.includes("stopped again"))?.fg.equals(theme.warning)).toBe(true)
  })

  it("renders a lost runtime in the error color with the lane's reset", async () => {
    const { frame, spans } = await renderNotice({ kind: "faulted", since: 1 })
    expect(frame).toContain("Flywheel's background service stopped answering.")
    expect(frame).toContain("Flywheel keeps trying to reach it. If this notice stays, run `flywheel kill`, then start Flywheel again.")
    expect(spans.find((span) => span.text.includes("stopped answering"))?.fg.equals(theme.error)).toBe(true)
  })

  it("renders a failed recovery as a fault, the way a lost runtime is", async () => {
    const { spans } = await renderNotice({ kind: "recovery_failed", cause: "some commands it started did not stop" })
    expect(spans.find((span) => span.text.includes("could not restore"))?.fg.equals(theme.error)).toBe(true)
  })

  it.each(["crash_loop", "restarting", "recovery_failed"] as const)("shows the account receipt for %s", async (kind) => {
    const { frame } = await renderNotice({ kind, cause: "failed", since: 1, report: { kind: "sent", reportId: "FW-1234" } })
    expect(frame).toContain("Report sent automatically (FW-1234). To stop automatic reports, turn off Bug reports in Settings.")
  })

  it.each(["crash_loop", "recovery_failed"] as const)("offers Copy of the account report after a %s report fails", async (kind) => {
    const { frame, copied, queries } = await renderNotice({ kind, cause: "failed", report: { kind: "failed" } }, true)
    expect(frame).toContain("Could not send bug report.")
    expect(frame).not.toContain("Report sent")
    expect(copied).toEqual(["account-assembled report"])
    expect(queries).toEqual([{ type: "bugReport.failed", source: kind === "crash_loop" ? "service" : "executor" }])
  })

  it("says a build that is not an official release sent no report and still offers Copy", async () => {
    const { frame, copied } = await renderNotice({ kind: "crash_loop", cause: "failed", report: { kind: "not-release" } }, true)
    expect(frame).toContain("No bug report was sent because this build is not an official Flywheel release.")
    expect(frame).not.toContain("Could not send")
    expect(copied).toEqual(["account-assembled report"])
  })
})
