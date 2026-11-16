/** @jsxImportSource @opentui/solid */

import { describe, expect, it, mock } from "bun:test"
import { testRender } from "@opentui/solid"
import { TextareaRenderable } from "@opentui/core"
import { createRoot, createSignal, onCleanup } from "solid-js"
import type { AttachedRuntimeClient, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { moduleDomainReader } from "../../../../src/protocol/client/module-domain.js"
import { createSurfaceOpener } from "../../../../src/protocol/client/surface-presentation.js"
import { experimentViewDomain } from "../../../../src/protocol/modules/experiments.js"
import { sideQuestionDomain } from "../../../../src/protocol/modules/side-question.js"
import { createSideQuestionSurface } from "../../../../src/tui/modules/side-question/surface.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createModalScrollController } from "../../../../src/tui/components/modal-scroll-controller.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import { createModuleDomainIntakes } from "../../../../src/tui/hooks/create-module-domain-intakes.js"
import { createModuleSlots, surfaceKeys } from "../../../../src/tui/hooks/create-module-slots.js"
import type { TuiModule, TuiNavigation, TuiComponentSurface, TuiStripKeyClaim } from "../../../../src/tui/tui-module.js"
import { createKeymap } from "../../../../src/tui/keymap/keymap.js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import type { ComposerHandle } from "../../../../src/tui/components/composer-types.js"
import { mountPrompt } from "../components/prompt-area-fixture.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** A runtime that answers every registry snapshot empty; the slots under test
 *  need the intakes, not their views. */
function fakeAppService() {
  const sequencer = createRuntimeUiPatchSequencer()
  const snapshotPosition = () => sequencer.snapshotPosition({ kind: "workspace", domains: ["output"] })
  const query = runtimeQuery({
    papercutCountSnapshot: async () => ({ papercuts: { undisposedCount: 0 }, snapshotPosition: snapshotPosition() }),
    definitionStalenessSnapshot: async () => ({ definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 }, snapshotPosition: snapshotPosition() }),
    projectNotificationSnapshot: async () => ({ notifications: [], snapshotPosition: snapshotPosition() }),
    experimentViewSnapshot: async () => ({ experimentView: null, snapshotPosition: snapshotPosition() }),
    sideQuestionSnapshot: async () => ({ view: { revision: 1, exchanges: [] }, snapshotPosition: snapshotPosition() }),
    sideQuestionRequestSnapshot: async () => ({ view: { current: { id: "admitted", question: "Question", answer: "", state: "running" } }, snapshotPosition: snapshotPosition() }),
  })
  const lanes = fakeLanes()
  return {
    query,
    subscribe: () => () => {},
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
}

/** Kernel destinations no surface under test reaches. */
const NAVIGATE: TuiNavigation = { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }
const CLIPBOARD = { copy: async (_text: string) => {} }
const CLIENT: Pick<RuntimeClient, "dispatch" | "query"> = { query: async () => { throw new Error("no query in this test") }, dispatch: async () => { throw new Error("no mutation is dispatched in this test") } }

const SURFACE: TuiComponentSurface = {
  id: "synthetic-board",
  title: "Board",
  width: 60,
  controls: ["esc close"],
  load: async () => () => <text>the board</text>,
}

const THROWING_SURFACE: TuiComponentSurface = { ...SURFACE, id: "broken-board", load: async () => () => { throw new Error("board exploded") } }

/** A module no host names: one strip and one surface, registered by list membership alone. */
function syntheticModule(strip: TuiModule["strip"]): TuiModule {
  return { id: "development", strip, surfaces: [SURFACE, THROWING_SURFACE] }
}

function harness(modules: readonly TuiModule[]) {
  const modal = createModalStack()
  const toasts: string[] = []
  const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
  const built = createRoot((dispose) => {
    const service = fakeAppService()
    const intakes = createModuleDomainIntakes({ appService: service, hydration: service })
    const slots = createModuleSlots({ answering: () => true, modules, intakes, foregroundId, modal, client: CLIENT, clipboard: CLIPBOARD, navigate: NAVIGATE, showToast: (input) => {
      const options = typeof input === "function" ? input() : input
      if (options !== null) toasts.push(options.message)
    } })
    return { dispose, slots }
  })
  return { ...built, modal, toasts, setForegroundId }
}

describe("createModuleSlots", () => {
  it("renders a synthetic module's strip beside the composer and contains a strip that throws to one toast naming the module", async () => {
    const working = harness([syntheticModule((props) => <text>{`strip for ${props.sessionId}`}</text>)])
    const Strips = working.slots.Strips
    const rendered = await testRender(() => (
      <ThemeProvider mode="dark">
        <box flexDirection="column">
          <Strips sessionId={() => "chat-1"} width={() => 40}><text>composer</text></Strips>
        </box>
      </ThemeProvider>
    ), { width: 40, height: 6 })
    try {
      await rendered.renderOnce()
      const frame = rendered.captureCharFrame()
      expect(frame).toContain("strip for chat-1")
      expect(frame).toContain("composer")
      expect(working.toasts).toEqual([])
    } finally {
      rendered.renderer.destroy()
      working.dispose()
    }

    const broken = harness([syntheticModule(() => { throw new Error("strip exploded") })])
    const BrokenStrips = broken.slots.Strips
    const contained = await testRender(() => (
      <ThemeProvider mode="dark">
        <box flexDirection="column">
          <BrokenStrips sessionId={() => "chat-1"} width={() => 40}><text>composer</text></BrokenStrips>
        </box>
      </ThemeProvider>
    ), { width: 40, height: 6 })
    try {
      await contained.renderOnce()
      expect(contained.captureCharFrame().trim()).toBe("composer")
      expect(broken.toasts).toEqual(["The development module could not render its strip: strip exploded"])
    } finally {
      contained.renderer.destroy()
      broken.dispose()
    }
  })

  it("renders each strip on the side of the composer that its module names, above when it names none, and none without a session", async () => {
    const [sessionId, setSessionId] = createSignal<string | undefined>("chat-1")
    const h = harness([
      { id: "development", strip: () => <text>below strip</text>, stripPlacement: "below" },
      { id: "experiments", strip: () => <text>above strip</text> },
    ])
    const Strips = h.slots.Strips
    const rendered = await testRender(() => (
      <ThemeProvider mode="dark">
        <box flexDirection="column">
          <Strips sessionId={sessionId} width={() => 40}><text>composer</text></Strips>
        </box>
      </ThemeProvider>
    ), { width: 40, height: 6 })
    try {
      await rendered.renderOnce()
      expect(rendered.captureCharFrame().split("\n").map((line) => line.trim()).filter(Boolean)).toEqual(["above strip", "composer", "below strip"])
      setSessionId(undefined)
      await rendered.renderOnce()
      expect(rendered.captureCharFrame().trim()).toBe("composer")
    } finally {
      rendered.renderer.destroy()
      h.dispose()
    }
  })

  it("opens a synthetic surface by id for the foreground session, closes it when the foreground moves, and reads the module's own domains", async () => {
    const h = harness([syntheticModule(undefined)])
    try {
      expect([...h.slots.surfaces.keys()]).toEqual(["synthetic-board", "broken-board"])
      h.slots.surfaces.get("synthetic-board")?.()
      expect(h.modal.stack).toHaveLength(1)
      h.setForegroundId("chat-2")
      expect(h.modal.stack).toHaveLength(0)

      h.setForegroundId(undefined)
      h.slots.surfaces.get("synthetic-board")?.()
      expect(h.modal.stack).toHaveLength(0)

      // Rows read through the same reader a surface receives: an empty registry view is an absent row.
      expect(h.slots.introRows()).toEqual([])
      await Bun.sleep(0)
      expect(h.slots.statusRows().map((row) => row.id)).toEqual(["definition-overrides", "papercuts", "project-notifications"])
    } finally {
      h.dispose()
    }
  })

  it("contains a surface that throws while rendering: one toast names the module and the modal leaves the stack", async () => {
    const h = harness([syntheticModule(undefined)])
    h.slots.surfaces.get("broken-board")?.()
    const entry = h.modal.stack[0]
    if (entry === undefined) throw new Error("the surface did not open")
    const element = entry.element
    const rendered = await testRender(() => <ThemeProvider mode="dark">{typeof element === "function" ? element() : element}</ThemeProvider>, { width: 80, height: 20 })
    try {
      await rendered.renderOnce()
      await Bun.sleep(0)
      await rendered.renderOnce()
      await Bun.sleep(0)
      expect(h.toasts).toEqual(["The development module could not render its Board: board exploded"])
      expect(h.modal.stack).toHaveLength(0)
    } finally {
      rendered.renderer.destroy()
      h.dispose()
    }
  })

  it.each([
    [undefined, "chat-1"],
    // A strip in a view over the tab in front opens its surface for the chat that the view shows.
    ["shown", "shown"],
  ])("hands a surface the session it opened for, %p named, and a reader over that session's domains", async (named, expected) => {
    let seen: { sessionId: string; view: unknown } | undefined
    const h = harness([{ id: "development", surfaces: [{ ...SURFACE, load: async () => (props) => { seen = { sessionId: props.sessionId, view: props.read(experimentViewDomain) }; return <text>ok</text> } }] }])
    h.slots.surfaces.get("synthetic-board")?.(named === undefined ? {} : { sessionId: named })
    const entry = h.modal.stack[0]
    if (entry === undefined) throw new Error("the surface did not open")
    const element = entry.element
    const rendered = await testRender(() => <ThemeProvider mode="dark">{typeof element === "function" ? element() : element}</ThemeProvider>, { width: 80, height: 20 })
    try {
      await rendered.renderOnce()
      await Bun.sleep(0)
      await rendered.renderOnce()
      expect(seen).toEqual({ sessionId: expected, view: undefined })
      expect(rendered.captureCharFrame()).toContain("ok")
    } finally {
      rendered.renderer.destroy()
      h.dispose()
    }
  })
})

describe("module strip keys", () => {
  it("takes the prompt's focus for a claiming strip, gives it back on a key it does not take, a paste, or a press on the prompt, and ends it on a question or a foreground change", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const [question, setQuestion] = createSignal(false)
    const [overrides, setOverrides] = createSignal<{ readonly [command: string]: string }>({})
    const issues: string[] = []
    const taken: string[] = []
    let claim: TuiStripKeyClaim | undefined
    let empty: (() => boolean) | undefined
    const strip: TuiModule["strip"] = (props) => {
      empty = props.composer.empty
      claim = props.keys.claim({ chords: ["down", "escape", "ctrl+g", "ctrl+n"], onKey: (event) => {
        const own = event.name === "down" || event.name === "escape"
        if (own) taken.push(event.name)
        return own
      } })
      return <text>strip</text>
    }
    const service = fakeAppService()
    const draftCache = createDraftCache()
    let composer: ComposerHandle | undefined
    const built = createRoot((dispose) => ({ dispose, slots: createModuleSlots({
      answering: () => true, modules: [syntheticModule(strip)], intakes: createModuleDomainIntakes({ appService: service, hydration: service }), foregroundId, modal: createModalStack(), client: CLIENT, clipboard: CLIPBOARD, navigate: NAVIGATE, showToast: () => {},
      keymap: { commandAt: (chord) => createKeymap(overrides()).keymap.commandAt(chord) }, reportIssue: (message) => { issues.push(message) },
      composer: { hasDraft: draftCache.hasDraft, syncFocus: () => composer?.syncFocus() },
      foregroundQuestion: question,
    }) }))
    const { slots } = built
    const Strips = slots.Strips
    const rendered = await mountPrompt({
      draftCache, foregroundId, ref: (handle) => { composer = handle },
      captureFocus: () => !slots.stripFocused(), onPromptPress: slots.releaseStripFocus,
      above: () => <Strips sessionId={() => "chat-1"} width={() => 80} />,
    })
    // The shell's keyboard handler is a global listener that offers keys to the strips.
    rendered.renderer.keyInput.on("keypress", (event) => { slots.stripInput(event) })
    const promptFocused = () => rendered.renderer.currentFocusedRenderable instanceof TextareaRenderable
    const focusStrip = async () => { claim?.setFocused(true); await Bun.sleep(0) }
    try {
      await rendered.renderOnce()
      await Bun.sleep(0)
      if (!claim || !empty) throw new Error("the strip did not claim")
      expect(empty()).toBe(true)
      expect(promptFocused()).toBe(true)
      const ctrlN = "The development module's key \"ctrl+n\" is bound to the command \"new\", which keeps it. Bind \"new\" to another key in [keybindings] to free \"ctrl+n\"."
      expect(issues).toEqual([ctrlN])
      // A later [keybindings] publication that binds another declared chord is reported once, with no remount.
      setOverrides({ new: "ctrl+g" })
      setOverrides({ new: "ctrl+g", help: "ctrl+y" })
      expect(issues).toEqual([ctrlN, "The development module's key \"ctrl+g\" is bound to the command \"new\", which keeps it. Bind \"new\" to another key in [keybindings] to free \"ctrl+g\"."])

      expect(slots.stripInput({ name: "x" })).toBe(false)
      await focusStrip()
      expect(slots.stripFocused()).toBe(true)
      expect(promptFocused()).toBe(false)
      rendered.mockInput.pressArrow("down")
      expect(slots.stripInput({ name: "escape" })).toBe(true)
      expect(slots.stripInput({ name: "left" })).toBe(true)
      expect(slots.stripFocused()).toBe(true)
      expect(taken).toEqual(["down", "escape"])

      // Two keys the strip does not take, in one stdin chunk, both land in the prompt once.
      rendered.mockInput.pressKey("ab")
      expect(slots.stripFocused()).toBe(false)
      expect(promptFocused()).toBe(true)
      await Bun.sleep(50)
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("ab")
      expect(rendered.captureCharFrame()).not.toContain("aab")
      expect(empty()).toBe(false)

      await focusStrip()
      await rendered.mockInput.pasteBracketedText("cd")
      expect(slots.stripFocused()).toBe(false)
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("abcd")

      await focusStrip()
      const promptRow = rendered.captureCharFrame().split("\n").findIndex((line) => line.includes("abcd"))
      await rendered.mockMouse.click(10, promptRow)
      expect(slots.stripFocused()).toBe(false)
      expect(promptFocused()).toBe(true)

      claim.setFocused(true)
      setQuestion(true)
      expect(claim.focused()).toBe(false)
      claim.setFocused(true)
      expect(claim.focused()).toBe(false)
      setQuestion(false)
      claim.setFocused(true)
      setForegroundId("chat-2")
      expect(slots.stripFocused()).toBe(false)
    } finally {
      rendered.renderer.destroy()
      built.dispose()
    }
  })
})

describe("surfaceKeys", () => {
  it("routes the shared vocabulary to scroll and close, after the surface's own handler", () => {
    const scrollBy = mock((rows: number) => { void rows })
    const pageBy = mock((direction: number) => { void direction })
    const scrollTo = mock((row: number) => { void row })
    const close = mock(() => {})
    const scroll = createModalScrollController()
    scroll.scrollBy = scrollBy
    scroll.pageBy = pageBy
    scroll.scrollTo = scrollTo
    const host = { read: moduleDomainReader(() => undefined), client: CLIENT, navigate: NAVIGATE, showToast: () => {}, scroll, close }
    const own = mock((event: { name: string }) => event.name === "x")
    const handle = surfaceKeys({ ...SURFACE, onKey: own }, host)

    for (const name of ["down", "j", "up", "k"]) handle({ name })
    for (const name of ["pagedown", "d", "pageup", "u"]) handle({ name })
    handle({ name: "g" })
    handle({ name: "g", shift: true, sequence: "G" })
    handle({ name: "x" })
    handle({ name: "q" })
    handle({ name: "escape" })

    expect(scrollBy.mock.calls.map(([rows]) => rows)).toEqual([1, 1, -1, -1])
    expect(pageBy.mock.calls.map(([direction]) => direction)).toEqual([1, 1, -1, -1])
    expect(scrollTo.mock.calls.map(([row]) => row)).toEqual([0, Number.MAX_SAFE_INTEGER])
    expect(own).toHaveBeenCalledTimes(13)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe("controlled module surfaces", () => {
  it("checks retained presentation intent at controller load completion", async () => {
    for (const scenario of ["session", "modal", "newest", "global"] as const) {
      const loader = Promise.withResolvers<(host: import("../../../../src/tui/tui-module.js").TuiControllerHost) => () => void>()
      const openedFor: (string | undefined)[] = []
      const h = harness([{ id: "development", surfaces: [{ id: "board", loadController: () => loader.promise }] }])
      let sessionId = "chat-1"
      let placement = 0
      const capture = createSurfaceOpener({
        sessionId: () => sessionId, placement: () => placement, surfaces: () => [h.modal.stack],
        openSurface: (id, isCurrent) => h.slots.surfaces.get(id)?.({ isCurrent }),
      })
      try {
        capture()("board", "chat-1")
        if (scenario === "session" || scenario === "newest" || scenario === "global") {
          sessionId = "chat-2"; placement++; h.setForegroundId(sessionId)
        }
        const newerModal = scenario === "modal" ? h.modal.replace(undefined) : undefined
        if (scenario === "newest") capture()("board", "chat-2")
        if (scenario === "global") capture()("board")
        loader.resolve((host) => () => { openedFor.push(host.foregroundId()); host.modal.replace(undefined) })
        await Promise.resolve(); await Promise.resolve()
        expect(openedFor).toEqual(scenario === "newest" || scenario === "global" ? ["chat-2"] : [])
        if (newerModal) expect(newerModal.isOpen()).toBe(true)
      } finally { h.dispose() }
    }
  })

  it("lets the latest direct opening replace a pending guarded request, checks cached guards, and answers the controller's acceptance", async () => {
    const loader = Promise.withResolvers<(host: import("../../../../src/tui/tui-module.js").TuiControllerHost) => (argument?: string) => Promise<boolean>>()
    const opened = mock(async (argument?: string) => argument !== "refused")
    const h = harness([{ id: "development", surfaces: [{ id: "board", loadController: () => loader.promise }] }])
    try {
      const open = h.slots.surfaces.get("board")
      const replaced = open?.({ isCurrent: () => false })
      const first = open?.({ argument: "refused" })
      loader.resolve(() => opened)
      expect(await replaced).toBe(true)
      expect(await first).toBe(false)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(await open?.({ isCurrent: () => false })).toBe(true)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(await open?.()).toBe(true)
      expect(opened).toHaveBeenCalledTimes(2)
    } finally { h.dispose() }
  })

  it("withdraws admission without stopping a side request while its view remains cached", async () => {
    const [enabled, setEnabled] = createSignal<readonly TuiModule["id"][]>(["side-question"])
    const dispatch = mock(async () => { throw new Error("no mutation is dispatched in this test") })
    const modal = createModalStack()
    const service = fakeAppService()
    let cachedDuringRetirement = false
    const module: TuiModule = { id: "side-question", surfaces: [{ id: "side-question", loadController: async () => (host) => {
      onCleanup(() => { cachedDuringRetirement = !!host.read(sideQuestionDomain) })
      return createSideQuestionSurface(host)
    } }] }
    const built = createRoot((dispose) => {
      const intakes = createModuleDomainIntakes({ appService: service, hydration: service })
      intakes["side-question"].ensure("parent")
      intakes["side-question-request"].ensure("parent")
      return { dispose, slots: createModuleSlots({ answering: () => true, modules: [module], intakes, foregroundId: () => "parent", modal, client: { ...CLIENT, dispatch }, clipboard: CLIPBOARD, navigate: NAVIGATE, showToast: () => {}, enabled }) }
    })
    try {
      await Promise.resolve(); await Promise.resolve()
      built.slots.surfaces.get("side-question")?.()
      await Promise.resolve(); await Promise.resolve()
      expect(modal.stack).toHaveLength(1)
      setEnabled([])
      expect(cachedDuringRetirement).toBe(true)
      expect(modal.stack).toHaveLength(0)
      expect(dispatch).not.toHaveBeenCalled()
      built.slots.surfaces.get("side-question")?.()
      expect(modal.stack).toHaveLength(0)
    } finally { built.dispose() }
  })

  it("loads on open, retains one keyboard owner, and releases it when the module turns off", async () => {
    const [enabled, setEnabled] = createSignal<readonly TuiModule["id"][] | undefined>()
    const opened = mock(() => {})
    const released = mock(() => {})
    const status = mock(async () => [{ id: "month", label: "Month spend", value: "$3.00" }])
    const loadController = mock(async () => (host: import("../../../../src/tui/tui-module.js").TuiControllerHost) => {
      expect(host.clipboard).toBe(CLIPBOARD)
      expect(host.navigate).toBe(NAVIGATE)
      onCleanup(released)
      return opened
    })
    const module: TuiModule = { id: "development", surfaces: [{ id: "board", loadController }], status }
    const modal = createModalStack()
    const service = fakeAppService()
    const built = createRoot((dispose) => ({
      dispose,
      slots: createModuleSlots({ answering: () => true, modules: [module], intakes: createModuleDomainIntakes({ appService: service, hydration: service }), foregroundId: () => undefined, modal, client: CLIENT, clipboard: CLIPBOARD, navigate: NAVIGATE, showToast: () => {}, enabled }),
    }))
    try {
      expect(loadController).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
      built.slots.surfaces.get("board")?.()
      await Promise.resolve(); await Promise.resolve()
      expect(loadController).toHaveBeenCalledTimes(1)
      expect(opened).toHaveBeenCalledTimes(1)
      setEnabled(["development"])
      built.slots.surfaces.get("board")?.()
      expect(opened).toHaveBeenCalledTimes(2)
      built.slots.refreshStatus()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(built.slots.statusRows()).toContainEqual({ id: "month", label: "Month spend", value: "$3.00" })
      setEnabled([])
      expect(released).toHaveBeenCalledTimes(1)
      expect(built.slots.statusRows().some((row) => row.id === "month")).toBe(false)
      built.slots.surfaces.get("board")?.()
      expect(opened).toHaveBeenCalledTimes(2)
    } finally { built.dispose() }
  })
})

describe("module status scope ownership", () => {
  it("discards late profile, session, and disabled readings and reports active failures once", async () => {
    const [sessionId, setSessionId] = createSignal<string | undefined>("chat")
    const [profileId, setProfileId] = createSignal("personal")
    const [enabled, setEnabled] = createSignal<readonly TuiModule["id"][]>(["development"])
    const readings: ReturnType<typeof Promise.withResolvers<readonly import("../../../../src/protocol/protocol-module.js").ModuleRow[]>>[] = []
    const module: TuiModule = { id: "development", status: () => { const request = Promise.withResolvers<readonly import("../../../../src/protocol/protocol-module.js").ModuleRow[]>(); readings.push(request); return request.promise } }
    const toasts: string[] = []
    const service = fakeAppService()
    const built = createRoot((dispose) => ({ dispose, slots: createModuleSlots({ answering: () => true,
      modules: [module], intakes: createModuleDomainIntakes({ appService: service, hydration: service }), foregroundId: sessionId, enabled,
      auth: () => ({ providers: [], warnings: [], profile: { id: profileId(), displayName: profileId(), source: "default", availableProfiles: [] }, subscriptionSpendConsent: { kind: "unavailable", profileId: profileId(), message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." } }),
      modal: createModalStack(), client: CLIENT, clipboard: CLIPBOARD, navigate: NAVIGATE, showToast: (toast) => { const input = typeof toast === "function" ? toast() : toast; if (input !== null) toasts.push(input.message) },
    }) }))
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const row = { id: "scoped", label: "Status", value: "ready" }
    const visible = () => built.slots.statusRows().filter((value) => value.id === row.id)
    try {
      built.slots.refreshStatus(); setProfileId("work"); readings[0]?.resolve([row]); await tick()
      expect(visible()).toEqual([])
      built.slots.refreshStatus(); setSessionId("other"); readings[1]?.resolve([row]); await tick()
      expect(visible()).toEqual([])
      built.slots.refreshStatus(); setEnabled([]); readings[2]?.reject(new Error("disabled read")); await tick()
      expect(visible()).toEqual([]); expect(toasts).toEqual([])
      setEnabled(["development"]); built.slots.refreshStatus(); readings[3]?.resolve([row]); await tick()
      expect(visible()).toEqual([row])
      built.slots.refreshStatus(); expect(visible()).toEqual([])
      readings[4]?.reject(new Error("current read")); await tick()
      expect(toasts).toHaveLength(1); expect(toasts[0]).toContain("current read")
      built.slots.refreshStatus(); built.dispose(); readings[5]?.reject(new Error("disposed read")); await tick()
      expect(toasts).toHaveLength(1)
    } finally { built.dispose() }
  })
})
