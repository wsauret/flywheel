/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextRenderable, type Renderable } from "@opentui/core"
import { createRoot, createSignal } from "solid-js"
import { displayWidth } from "../../../../src/tui/utils/text.js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { moduleDomainReader } from "../../../../src/protocol/client/module-domain.js"
import type { FrontendExperimentRun, FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import { sessionDomainCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { modalCopyLimit } from "../../../../src/tui/components/modal-copy.js"
import { createModalScrollController } from "../../../../src/tui/components/modal-scroll-controller.js"
import { SPINNER_FRAMES } from "../../../../src/tui/components/spinner.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import { createModuleDomainIntakes } from "../../../../src/tui/hooks/create-module-domain-intakes.js"
import { BASELINE_PENDING_COPY, CONFIDENCE_PENDING_COPY } from "../../../../src/tui/modules/experiments/dashboard-lines.js"
import { ExperimentDashboardModal } from "../../../../src/tui/modules/experiments/dashboard-modal.js"
import { experimentsTui } from "../../../../src/tui/modules/experiments/index.js"
import { ExperimentStrip } from "../../../../src/tui/modules/experiments/strip.js"
import { TUI_MODULES } from "../../../../src/tui/modules.js"
import type { DomainReader } from "../../../../src/protocol/protocol-module.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const theme = resolveTheme(flywheelTheme, "dark")

function run(overrides: Partial<FrontendExperimentRun> & { run: number }): FrontendExperimentRun {
  return { segment: 1, commit: "abc1234", metric: 100, metrics: {}, status: "keep", description: `run ${overrides.run}`, confidence: null, durationMs: 1000, ...overrides }
}

function view(overrides: Partial<FrontendExperimentView> = {}): FrontendExperimentView {
  return {
    name: "speedup",
    metric: { name: "time", unit: "ms" },
    secondaryMetrics: [],
    direction: "lower",
    segment: 1,
    baseline: null,
    best: null,
    confidence: null,
    runCounts: { total: 0, kept: 0, discarded: 0, crashed: 0, checksFailed: 0 },
    runs: [],
    active: true,
    running: false,
    ...overrides,
  }
}

const historyView = view({
  baseline: 200,
  confidence: 2.5,
  runCounts: { total: 3, kept: 2, discarded: 1, crashed: 0, checksFailed: 0 },
  runs: [
    run({ run: 1, segment: 0, metric: 250, commit: "0000000", description: "old baseline" }),
    run({ run: 2, metric: 200, commit: "aaaaaaa", description: "baseline" }),
    run({ run: 3, metric: 180, commit: "bbbbbbb", description: "faster loop" }),
    run({ run: 4, metric: 240, status: "discard", commit: "", description: "slower" }),
  ],
})

const experimentViewCursor = (sessionId: string) => sessionDomainCursor("experiment_view", sessionId)

interface InitialViews {
  [sessionId: string]: FrontendExperimentView | null
}

function fakeAppService(initial: InitialViews = {}) {
  const sequencer = createRuntimeUiPatchSequencer()
  const snapshots = new Map(Object.entries(initial))
  // Every registry domain subscribes on its own, so the fake fans out.
  const listeners = new Set<(event: FrontendEvent) => void>()
  const query = runtimeQuery({
    papercutCountSnapshot: async () => ({ papercuts: { undisposedCount: 0 }, snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: { scope: "workspace", domain: "papercuts" } }) }),
    definitionStalenessSnapshot: async () => ({ definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 }, snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: { scope: "workspace", domain: "definitionStaleness" } }) }),
    projectNotificationSnapshot: async () => ({ notifications: [], snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: { scope: "workspace", domain: "project_notifications" } }) }),
    experimentViewSnapshot: async (request) => ({
      experimentView: snapshots.get(request.sessionId) ?? null,
      snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: experimentViewCursor(request.sessionId) }),
    }),
  })
  const lanes = fakeLanes()
  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  return {
    service,
    live: (sessionId: string, next: FrontendExperimentView | null) => {
      const payload = next ? { kind: "experiment_view.updated" as const, experimentView: next } : { kind: "experiment_view.removed" as const }
      const patch = sequencer.publish({ cursor: experimentViewCursor(sessionId), payload })
      for (const listener of listeners) listener({ type: "patch", patch })
    },
  }
}

/** A reader that answers the experiment domain from one accessor, the way the
 *  slot host's reader answers it from the session's intake. */
function readerOf(current: () => FrontendExperimentView | undefined): DomainReader {
  return moduleDomainReader((domain) => (domain.domain === "experiment_view" ? current() : undefined))
}

async function renderStrip(current: () => FrontendExperimentView | undefined, width = 100, openSurface = (_id: string) => {}) {
  const rendered = await testRender(() => (
    <ThemeProvider mode="dark">
      <TickPoolProvider>
        <ExperimentStrip sessionId="chat-1" read={readerOf(current)} width={() => width} openSurface={openSurface} />
      </TickPoolProvider>
    </ThemeProvider>
  ), { width, height: 20 })
  await rendered.renderOnce()
  return rendered
}

describe("experiments terminal home", () => {
  it("registers one strip and the dashboard surface through the registry", () => {
    expect(TUI_MODULES).toContain(experimentsTui)
    expect(experimentsTui.strip).toBe(ExperimentStrip)
    expect(experimentsTui.surfaces.map((surface) => surface.id)).toEqual(["experiment-dashboard"])
    const [surface] = experimentsTui.surfaces
    for (const key of ["↑↓", "j/k", "pageup/pagedown", "u/d", "g/G", "esc", "q"]) expect(surface.controls[0]).toContain(key)
    expect(displayWidth(surface.controls[0])).toBeLessThanOrEqual(modalCopyLimit(surface.width))
  })
})

describe("experiment_view module intake", () => {
  it("seeds from the snapshot, applies ordered patches, and deletes the row on removal", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService({ "chat-1": view({ name: "seeded" }) })
      const cache = createModuleDomainIntakes({ appService: fake.service, hydration: fake.service }).experiment_view
      cache.ensure("chat-1")
      await Bun.sleep(0)
      expect(cache.view("chat-1")?.name).toBe("seeded")
      fake.live("chat-1", view({ name: "patched", running: true }))
      expect(cache.view("chat-1")?.name).toBe("patched")
      expect(cache.view("chat-1")?.running).toBe(true)
      fake.live("chat-1", null)
      expect(cache.view("chat-1")).toBeUndefined()
      expect(cache.view("chat-2")).toBeUndefined()
      dispose()
    })
  })
})

describe("ExperimentStrip", () => {
  it("updates positional styled lines without replacing their renderables", async () => {
    const [current, setCurrent] = createSignal(historyView)
    const rendered = await renderStrip(current)
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    const lines = () => descendants(rendered.renderer.root).filter((node) => node instanceof TextRenderable)
    try {
      const held = lines()
      setCurrent(structuredClone(historyView))
      await rendered.renderOnce()
      expect(lines().every((line, index) => line === held[index])).toBe(true)
      setCurrent({ ...historyView, confidence: 3.5 })
      await rendered.renderOnce()
      expect(lines().every((line, index) => line === held[index])).toBe(true)
      expect(rendered.captureCharFrame()).toContain("3.5×")
      expect(rendered.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("conf:"))?.fg.equals(theme.success)).toBe(true)
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("renders nothing without a view and a stable title row with a reserved spinner cell", async () => {
    const [current, setCurrent] = createSignal<FrontendExperimentView | undefined>(undefined)
    const rendered = await renderStrip(current)
    try {
      expect(rendered.captureCharFrame().trim()).toBe("")

      setCurrent(view())
      await rendered.renderOnce()
      const idle = rendered.captureCharFrame().split("\n")
      // Two-cell indent, the reserved spinner cell, one space, then the title.
      expect(idle[0]).toMatch(/^ {4}Experiment · speedup/)
      expect(idle[0]).toContain("Dashboard")
      expect(idle[1]).toContain("No experiments yet.")

      setCurrent(view({ running: true }))
      await rendered.renderOnce()
      const running = rendered.captureCharFrame().split("\n")
      expect(SPINNER_FRAMES).toContain(running[0]!.charAt(2))
      expect(running[0]!.indexOf("Experiment")).toBe(idle[0]!.indexOf("Experiment"))

      setCurrent(undefined)
      await rendered.renderOnce()
      expect(rendered.captureCharFrame().trim()).toBe("")
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("names pending baseline and confidence and colors current versus old rows", async () => {
    const zeroRun = view({ runs: [run({ run: 1, segment: 0 })], baseline: null, confidence: null })
    const pending = await renderStrip(() => zeroRun)
    try {
      const frame = pending.captureCharFrame()
      expect(frame).toContain(BASELINE_PENDING_COPY)
      expect(frame).toContain(CONFIDENCE_PENDING_COPY)
    } finally {
      pending.renderer.destroy()
    }

    const rendered = await renderStrip(() => historyView)
    try {
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("(conf: 2.5×)")
      expect(frame).toContain("bbbbbbb")
      expect(frame).not.toContain("(old)")
      expect(frame).toContain("… 1 earlier run")
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      const kept = spans.find((span) => span.text.includes("bbbbbbb"))
      const conf = spans.find((span) => span.text.includes("conf:"))
      expect(kept?.fg.equals(theme.accent)).toBe(true)
      expect(conf?.fg.equals(theme.success)).toBe(true)
      for (const line of frame.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(100)
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("fits every line at a narrow composer width", async () => {
    const rendered = await renderStrip(() => historyView, 48)
    try {
      for (const line of rendered.captureCharFrame().split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(48)
    } finally {
      rendered.renderer.destroy()
    }
  })
})

describe("ExperimentDashboardModal", () => {
  it("renders every run with the declared footer, dims old rows, and states the empty session", async () => {
    const [surface] = experimentsTui.surfaces
    const scroll = createModalScrollController()
    const render = (current: () => FrontendExperimentView | undefined) => testRender(() => (
      <ThemeProvider mode="dark">
        <ExperimentDashboardModal sessionId="chat-1" read={readerOf(current)} client={{ dispatch: async () => { throw new Error("no mutation is dispatched in this test") } }} navigate={{ openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }} showToast={() => {}} scroll={scroll} width={surface.width} controls={surface.controls} onClose={() => {}} />
      </ThemeProvider>
    ), { width: 120, height: 30 })
    const [current, setCurrent] = createSignal(historyView)
    const rendered = await render(current)
    try {
      await rendered.renderOnce()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("Experiment · speedup")
      expect(frame).toContain("(old)")
      expect(frame).toContain("bbbbbbb")
      expect(frame).toContain(surface.controls[0])
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      const old = spans.find((span) => span.text.includes("(old)"))
      expect(old?.fg.equals(theme.textSubtle)).toBe(true)
      const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
      const lines = () => descendants(rendered.renderer.root).filter(node => node instanceof TextRenderable)
      const held = lines()
      setCurrent(structuredClone(historyView))
      await rendered.renderOnce()
      expect(lines().length).toBe(held.length)
      expect(lines().every((line, index) => line === held[index])).toBe(true)
      setCurrent({ ...historyView, confidence: 3.5 })
      await rendered.renderOnce()
      expect(lines().every((line, index) => line === held[index])).toBe(true)
      expect(rendered.captureCharFrame()).toContain("3.5×")
      expect(rendered.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("conf:"))?.fg.equals(theme.success)).toBe(true)
    } finally {
      rendered.renderer.destroy()
    }

    const empty = await render(() => undefined)
    try {
      await empty.renderOnce()
      expect(empty.captureCharFrame()).toContain("This session has no experiment.")
    } finally {
      empty.renderer.destroy()
    }
  })
})
