import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextRenderable, type Renderable } from "@opentui/core"
import { createSignal, type Accessor } from "solid-js"
import { createComponent } from "solid-js/web"
import stringWidth from "string-width"
import type { ModuleRow } from "../../../src/protocol/protocol-module.js"
import type { RuntimeIdentity } from "../../../src/protocol/client/runtime-identity.js"
import type { UpdateStatusView } from "../../../src/protocol/update-protocol-types.js"
import flywheelTheme from "../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../src/tui/context/theme/resolve.js"
import { BOLD, UNDERLINE } from "../../../src/tui/utils/text-attributes.js"

const theme = resolveTheme(flywheelTheme, "dark")

/** The account home the card abbreviates paths against, and the account data
 *  root the font tip reads config from. Both are fixed fake paths, so the
 *  rendered card never depends on the developer's own account state. */
const ACCOUNT_HOME = "/Users/test"

interface RenderOptions { runtimeIdentity?: Accessor<RuntimeIdentity | undefined>; showBuild?: Accessor<boolean>; availableWidth?: number; frameWidth?: number; frameHeight?: number; projectRoot?: string; accountHome?: string; tabsHintDismissed?: boolean; onDismissTabsHint?: () => void; clickTabsHintDismiss?: boolean; fontTipDismissed?: Accessor<boolean>; moduleRows?: readonly ModuleRow[]; branchName?: Accessor<string | undefined>; modelLabel?: Accessor<string | undefined>; profileName?: Accessor<string | undefined>; noProviderReady?: boolean; afterFirstRender?: () => void; releaseNotice?: Accessor<UpdateStatusView["releaseNotice"]>; onDismissReleaseNotice?: () => void; clickReleaseNoticeDismiss?: boolean }

interface RenderedSpan { readonly text: string; readonly fg: { equals(other: unknown): boolean }; readonly attributes: number }

async function renderSessionIntroSpans(options: RenderOptions = {}): Promise<{ frame: string; spans: readonly RenderedSpan[]; links: readonly string[] }> {
  const [{ SessionIntroBlock }, { ThemeProvider }] = await Promise.all([
    import("../../../src/tui/welcome-notice.js"),
    import("../../../src/tui/context/theme.js"),
  ])

  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(SessionIntroBlock, {
          runtimeIdentity: options.runtimeIdentity ?? (() => ({ version: "0.0.1", buildId: "3029f1ab99887766" })),
          showBuild: options.showBuild ?? (() => false),
          projectRoot: () => options.projectRoot ?? "/Users/test/Documents/GitHub/example-project/flywheel-tui",
          accountHome: options.accountHome ?? ACCOUNT_HOME,
          userDataRoot: `${options.accountHome ?? ACCOUNT_HOME}/.flywheel`,
          sessionKind: () => "chat",
          modelLabel: options.modelLabel ?? (() => "gpt-5.5 xhigh"),
          profileName: options.profileName ?? (() => "personal"),
          moduleRows: () => options.moduleRows ?? [],
          availableWidth: () => options.availableWidth ?? 90,
          noProviderReady: () => options.noProviderReady ?? false,
          branchName: options.branchName ?? (() => "main"),
          tabsHintDismissed: () => options.tabsHintDismissed ?? false,
          onDismissTabsHint: options.onDismissTabsHint ?? (() => {}),
          fontTipDismissed: options.fontTipDismissed ?? (() => false),
          releaseNotice: options.releaseNotice === undefined ? undefined : { notice: options.releaseNotice, dismiss: options.onDismissReleaseNotice ?? (() => {}) },
        })
      },
    }),
    { width: options.frameWidth ?? 100, height: options.frameHeight ?? 16 },
  )

  try {
    await result.renderOnce()
    options.afterFirstRender?.()
    if (options.clickTabsHintDismiss) await clickTabsHintDismiss(result)
    if (options.clickReleaseNoticeDismiss) {
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Updated to"))
      if (y < 0) throw new Error("release notice is not rendered")
      await result.mockMouse.click(lines[y]!.trimEnd().lastIndexOf("x"), y)
    }
    await result.renderOnce()
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    const links = descendants(result.renderer.root).flatMap((node) => node instanceof TextRenderable ? node.chunks.flatMap((chunk) => chunk.link ? [chunk.link.url] : []) : [])
    return { frame: result.captureCharFrame(), spans: result.captureSpans().lines.flatMap((line) => line.spans), links }
  } finally {
    result.renderer.destroy()
  }
}

async function renderSessionIntro(options: RenderOptions = {}): Promise<string> {
  return (await renderSessionIntroSpans(options)).frame
}

describe("SessionIntroBlock", () => {
  it("shows the runtime release notice first, bold with a muted link, and dismisses from its x button", async () => {
    let dismissals = 0
    const notice = { version: "0.1.2", message: "Updated to v0.1.2. Got 1 feature and 2 fixes.", url: "https://github.com/wsauret/flywheel/releases" }
    const rendered = await renderSessionIntroSpans({
      releaseNotice: () => notice,
      clickReleaseNoticeDismiss: true,
      onDismissReleaseNotice: () => { dismissals += 1 },
      frameHeight: 24,
    })
    expect(rendered.frame).toContain(notice.message)
    expect(rendered.frame).toContain(`${notice.url} for details`)
    expect(rendered.frame.indexOf("Updated to")).toBeLessThan(rendered.frame.indexOf("Each tab"))
    const message = rendered.spans.find((span) => span.text.includes("Updated to"))
    expect((message?.attributes ?? 0) & BOLD).toBe(BOLD)
    expect(rendered.spans.find((span) => span.text.includes(notice.url))?.fg.equals(theme.textMuted)).toBe(true)
    expect((rendered.spans.find((span) => span.text.includes(notice.url))?.attributes ?? 0) & UNDERLINE).toBe(UNDERLINE)
    expect(rendered.links).toContain(notice.url)
    expect(dismissals).toBe(1)
    const narrow = await renderSessionIntroSpans({ releaseNotice: () => notice, availableWidth: 28, frameWidth: 40, frameHeight: 32, tabsHintDismissed: true, fontTipDismissed: () => true })
    const lines = narrow.frame.split("\n").map((line) => line.trimEnd())
    expect(narrow.links).toContain(notice.url)
    for (const line of lines.slice(lines.findIndex((candidate) => candidate.includes("Updated to")))) expect(stringWidth(line.trimStart())).toBeLessThanOrEqual(28)
  })

  it("updates module counts and command affordances on the same renderable", async () => {
    const { SessionIntroBlock } = await import("../../../src/tui/welcome-notice.js")
    const { ThemeProvider } = await import("../../../src/tui/context/theme.js")
    const [rows, setRows] = createSignal<readonly ModuleRow[]>([{ id: "cuts", label: "papercuts", value: "5 logged", action: { kind: "command", id: "drain" } }])
    const result = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(SessionIntroBlock, {
      projectRoot: () => "/scratch", accountHome: "/scratch", userDataRoot: "/scratch/.flywheel", runtimeIdentity: () => undefined, showBuild: () => false,
      sessionKind: () => "chat", modelLabel: () => undefined, profileName: () => undefined, moduleRows: rows, availableWidth: () => 90, branchName: () => undefined,
      tabsHintDismissed: () => true, onDismissTabsHint() {}, fontTipDismissed: () => true,
    }) } }), { width: 100, height: 16 })
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    try {
      await result.renderOnce()
      const row = descendants(result.renderer.root).find(node => node instanceof TextRenderable && node.plainText.includes("5 logged"))
      if (!row) throw new Error("Missing module row")
      setRows([{ id: "cuts", label: "papercuts", value: "12 logged", action: { kind: "command", id: "review" } }])
      await result.renderOnce()
      expect(descendants(result.renderer.root).includes(row)).toBe(true)
      expect(result.captureCharFrame()).toContain("12 logged")
      expect(result.captureCharFrame()).toContain("/review")
    } finally { result.renderer.destroy() }
  })
  it("renders the Flywheel summary and the tabs hint", async () => {
    const frame = await renderSessionIntro()

    expect(frame).toContain(">_ Flywheel (v0.0.1)")
    expect(frame).not.toContain("session:   chat")
    expect(frame).toContain("model:     gpt-5.5 xhigh   /model to change")
    expect(frame).toContain("project:   ~/Documents/…/example-project/flywheel-tui")
    expect(frame).toContain("profile:   personal   /settings to change")
    expect(frame).toContain("Each tab is one session")
    expect(frame).not.toContain("ctrl+n new chat")
    expect(frame).not.toContain("? help")
  })

  it("names the /auth remedy when no model provider is ready, whatever the reason", async () => {
    const frame = await renderSessionIntro({ noProviderReady: true, frameHeight: 20 })
    expect(frame.replace(/[│\s]+/g, " ")).toContain("No model provider is ready; run `/auth` to set one up.")
  })

  it("leaves the profile line out when the card names no profile", async () => {
    expect(await renderSessionIntro({ profileName: () => undefined })).not.toContain("profile:")
  })

  it("distinguishes a pending model label from a resolved unconfigured default", async () => {
    expect(await renderSessionIntro({ modelLabel: () => undefined })).not.toContain("model:")
    expect(await renderSessionIntro({ modelLabel: () => "not configured" })).toContain("model:     not configured   /model to change")
  })

  it("updates the branch when Git HEAD changes", async () => {
    const [branchName, setBranchName] = createSignal<string | undefined>("main")
    const frame = await renderSessionIntro({
      branchName,
      afterFirstRender: () => setBranchName("feature/reactive-branch"),
    })

    expect(frame).toContain("branch:    feature/reactive-branch")
    expect(frame).not.toContain("branch:    main")
  })

  it("shows the live backend identity, the build only when enabled, and no version before identity arrives", async () => {
    const [identity, setIdentity] = createSignal<RuntimeIdentity | undefined>(undefined)
    const [showBuild, setShowBuild] = createSignal(false)
    expect(await renderSessionIntro({ runtimeIdentity: identity, showBuild })).not.toContain("(v")
    const swapped = await renderSessionIntro({
      runtimeIdentity: identity,
      showBuild,
      afterFirstRender: () => { setIdentity({ version: "0.0.10", buildId: "3029f1abdeadbeef" }) },
    })
    expect(swapped).toContain(">_ Flywheel (v0.0.10)")
    const built = await renderSessionIntro({
      runtimeIdentity: identity,
      showBuild,
      afterFirstRender: () => { setShowBuild(true) },
    })
    expect(built).toContain(">_ Flywheel (v0.0.10 build 3029f1ab)")
    const narrow = await renderSessionIntro({ runtimeIdentity: identity, showBuild, availableWidth: 28, frameWidth: 40, frameHeight: 24 })
    expect(narrow).toContain("3029f1ab)")
    const unavailable = await renderSessionIntro({
      runtimeIdentity: identity,
      showBuild,
      afterFirstRender: () => { setIdentity({ version: "0.0.10", buildId: null }) },
    })
    expect(unavailable).toContain(">_ Flywheel (v0.0.10 build unavailable)")
  })

  it("collapses and abbreviates Windows home paths", async () => {
    const frame = await renderSessionIntro({
      accountHome: "C:\\Users\\test",
      projectRoot: "C:\\Users\\test\\Documents\\GitHub\\example-project\\flywheel-tui",
    })

    expect(frame).toContain("project:   ~\\Documents\\…\\example-project\\flywheel-tui")
  })

  it("hides the tabs hint once it is dismissed", async () => {
    const frame = await renderSessionIntro({ tabsHintDismissed: true })

    expect(frame).toContain(">_ Flywheel (v0.0.1)")
    expect(frame).not.toContain("Each tab is one session")
  })

  it("dismisses the tabs hint from its x button", async () => {
    let dismissals = 0
    await renderSessionIntro({ clickTabsHintDismiss: true, onDismissTabsHint: () => { dismissals += 1 } })

    expect(dismissals).toBe(1)
  })

  it("wraps the tabs hint and its x button to the welcome card width", async () => {
    const frame = await renderSessionIntro({ availableWidth: 28, frameWidth: 40, frameHeight: 20 })
    const hintLines = frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => /Each tab|fresh one|closes it/.test(line))

    expect(hintLines.length).toBeGreaterThan(1)
    for (const line of hintLines) {
      expect(stringWidth(line.trimStart())).toBeLessThanOrEqual(28)
    }
  })

  it("renders a module command row in the kernel's command grammar with the command in the primary colour", async () => {
    const { frame, spans } = await renderSessionIntroSpans({ moduleRows: [{ id: "papercuts", label: "papercuts", value: "10 logged", action: { kind: "command", id: "papercuts" } }] })

    expect(frame).toContain("papercuts: 10 logged   /papercuts")
    expect(frame.match(/papercuts:/g)).toHaveLength(1)
    expect(spans.find((span) => span.text.includes("/papercuts"))?.fg.equals(theme.primary)).toBe(true)
    expect(spans.find((span) => span.text.includes("10 logged"))?.fg.equals(theme.text)).toBe(true)
  })

  it("renders a hinted module row dim after the value and a warning tone in the warning colour", async () => {
    const { frame, spans } = await renderSessionIntroSpans({ moduleRows: [
      { id: "definition-overrides", label: "overrides", value: "2 with upstream updates", hint: "ask to review them" },
      { id: "synthetic", label: "bench", value: "1 failing", tone: "warning" },
    ] })

    expect(frame).toContain("overrides: 2 with upstream updates   ask to review them")
    expect(frame).toContain("bench:     1 failing")
    expect(spans.find((span) => span.text.includes("ask to review them"))?.fg.equals(theme.textMuted)).toBe(true)
    expect(spans.find((span) => span.text.includes("1 failing"))?.fg.equals(theme.warning)).toBe(true)
  })

  it("truncates a module command row to the welcome card width", async () => {
    const frame = await renderSessionIntro({ availableWidth: 28, frameWidth: 40, moduleRows: [{ id: "papercuts", label: "papercuts", value: "12345 logged", action: { kind: "command", id: "papercuts" } }] })
    const row = frame.split("\n").find((line) => line.includes("papercuts:"))

    expect(row).toBeDefined()
    expect(stringWidth((row?.split("│")[1] ?? "").trimEnd())).toBeLessThanOrEqual(26)
    expect(row).toContain("/papercuts")
  })
})

/** Clicks the "x" that ends the first line of the tabs hint. */
async function clickTabsHintDismiss(result: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  const lines = result.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("Each tab is one session"))
  const x = lines[y]?.trimEnd().lastIndexOf("x") ?? -1
  if (y < 0 || x < 0) throw new Error("tabs hint dismiss button not rendered")
  await result.mockMouse.click(x, y)
}
