import { describe, expect, it, mock } from "bun:test"
import { fileURLToPath } from "node:url"
import type { BuiltInCommandDescriptor, CommandOutcome } from "../../../../src/protocol/command-catalog-protocol-types.js"
import { buildCommandDefinitions } from "../../../../src/tui/commands/command-definitions.js"
import { createCommandDispatch, createCommandUsageRecorder } from "../../../../src/tui/commands/command-dispatch.js"
import type { BuiltInCommandDefinition } from "../../../../src/tui/commands/command-types.js"
import { bindRuntimeCommandDefinitions } from "../../../../src/tui/commands/runtime-command-bindings.js"
import { createSurfaceOpener } from "../../../../src/protocol/client/surface-presentation.js"
import { createOverlayLayers } from "../../../../src/tui/components/modal-stack.js"
import type { SurfaceRequest } from "../../../../src/tui/commands/command-surfaces.js"
import { commandSpecs, commandsToOptions } from "../../../../src/tui/commands/command-catalog.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { testCommandContext } from "../../../helpers/command-context.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

describe("built-in command definitions", () => {
  it("lists a published descriptor under its catalog name and keyboard shortcut, and opens its surface at its target", async () => {
    const published: BuiltInCommandDescriptor = { id: "model-and-effort", title: "Model and effort", description: "Choose the model and effort", aliases: ["effort"], opens: "models", target: { kind: "transcript-in-view" } }
    const definitions = buildCommandDefinitions((id) => id === "help" ? "ctrl+p" : "", [published, { id: "help", title: "Commands", description: "List every command", aliases: [], opens: "commands" }])
    const rows = commandsToOptions(commandSpecs(definitions))
    expect(rows.filter((row) => row.title === "Model and effort").map((row) => [row.value, row.footer])).toEqual([["/model-and-effort", "/model-and-effort /effort"]])
    expect(rows.find((row) => row.id === "help")?.description).toBe("List every command (ctrl+p)")
    const openSurface = mock(() => true)
    const dispatch = createCommandDispatch({
      definitions: () => definitions,
      context: testCommandContext({ openSurface }),
      showToast: mock(() => {}),
      offCommands: () => [],
      catalog: { known: () => true, arrived: Promise.resolve() },
    })
    expect(await dispatch.dispatch("/effort")).toBe(true)
    expect(openSurface).toHaveBeenCalledWith("models", { target: { kind: "transcript-in-view" } })
  })

  it("opens Usage through the module's published command outcome", async () => {
    expect(buildCommandDefinitions(() => "ctrl+u").some(({ spec }) => spec.id === "usage")).toBe(false)
    const [definition] = bindRuntimeCommandDefinitions([{ id: "usage", title: "Usage", description: "View subscription usage and request spend", aliases: [] }], () => "")
    if (!definition) throw new Error("Expected the module command binding")
    const { context, dispatch, openSurface } = commandContext({ kind: "open", surface: "usage" })
    expect(await definition.execute(context, undefined)).toBe(true)
    await flush()
    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "usage", revision: 4, sessionId: "chat-1" })
    expect(openSurface).toHaveBeenCalledWith("usage", { isCurrent: expect.any(Function) })
  })

  it("opens the surface a descriptor publishes without asking the runtime, so it opens while the runtime does not answer", async () => {
    const [definition] = bindRuntimeCommandDefinitions([{ id: "remote", title: "Remote access", description: "Pair a phone and manage remote access", aliases: ["pair"], opens: "remote" }], () => "")
    if (!definition) throw new Error("Expected the module command binding")
    const { context, dispatch, openSurface } = commandContext({ kind: "none" })
    dispatch.mockImplementation(async () => { throw new Error("An error occurred during Write: the channel closed") })
    expect(await definition.execute(context, undefined)).toBe(true)
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
    expect(openSurface).toHaveBeenCalledWith("remote", {})
    // A surface that refuses the opening, such as Report a bug with an oversized note, gives the prompt the command back.
    openSurface.mockImplementationOnce(async () => false)
    expect(await definition.execute(context, "x")).toBe(false)
  })

  it("restarts through the host's restart, and a restart that cannot complete says why in an error toast", async () => {
    const restart = buildCommandDefinitions(() => "").find(({ spec }) => spec.id === "restart")
    if (!restart) throw new Error("Expected the restart command")
    const showToast = mock((_toast: { readonly message: string; readonly variant: string; readonly duration?: number }) => {})
    const restartHost = mock(async (): Promise<never> => { throw new Error("the account service refused the restart") })

    expect(await restart.execute(testCommandContext({ showToast, restart: restartHost }), undefined)).toBe(true)
    await flush()

    expect(restartHost).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls.map(([toast]) => [toast.variant, toast.message])).toEqual([
      ["info", "Restarting Flywheel"],
      ["error", "Flywheel could not restart: the account service refused the restart"],
    ])
    // A drain can outlast a timed toast, so the progress toast stays until replaced.
    expect(showToast.mock.calls[0]?.[0].duration).toBe(0)
  })

  it("propagates one immutable context and the parsed argument to the owning definition", async () => {
    const context = Object.freeze({ marker: Symbol("command context") })
    const execute = mock((receivedContext: typeof context, arg: string | undefined) => {
      expect(receivedContext).toBe(context)
      expect(arg).toBe("exact argument")
      return true
    })
    const definitions = [{
      spec: { id: "synthetic", title: "Synthetic", description: "Test command propagation", aliases: ["alias"] },
      execute,
    }] satisfies readonly BuiltInCommandDefinition<typeof context>[]
    const dispatch = createCommandDispatch({
      definitions: () => definitions,
      context,
      showToast: mock(() => {}),
      offCommands: () => [],
      catalog: { known: () => true, arrived: Promise.resolve() },
    })

    expect(await dispatch.dispatch('/alias "exact argument"')).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe("dispatch usage recording", () => {
  function makeDispatch(recordUsage: (token: string) => void) {
    const context = Object.freeze({ marker: Symbol("usage context") })
    const definitions = [{
      spec: { id: "synthetic", title: "Synthetic", description: "Test usage recording", aliases: ["alias"] },
      execute: () => true,
    }] satisfies readonly BuiltInCommandDefinition<typeof context>[]
    return createCommandDispatch({
      definitions: () => definitions,
      context,
      showToast: mock(() => {}),
      offCommands: () => [],
      catalog: { known: () => true, arrived: Promise.resolve() },
      recordUsage,
    })
  }

  it("records the lowercased entered alias once when a built-in consumes the input", async () => {
    const recorded: string[] = []
    const dispatch = makeDispatch((token) => recorded.push(token))
    expect(await dispatch.dispatch("/ALIAS argument")).toBe(true)
    expect(recorded).toEqual(["alias"])
  })

  it("starts usage recording before a built-in can begin shutdown", async () => {
    const calls: string[] = []
    const context = Object.freeze({ marker: Symbol("exit context") })
    const definitions = [{
      spec: { id: "exit", title: "Exit", description: "Exit Flywheel" },
      execute: () => { calls.push("execute"); return true },
    }] satisfies readonly BuiltInCommandDefinition<typeof context>[]
    const dispatch = createCommandDispatch({
      definitions: () => definitions,
      context,
      showToast: mock(() => {}),
      offCommands: () => [],
      catalog: { known: () => true, arrived: Promise.resolve() },
      recordUsage: (token) => { calls.push(`record:${token}`) },
    })

    expect(await dispatch.dispatch("/exit")).toBe(true)
    expect(calls).toEqual(["record:exit", "execute"])
  })

  it("records nothing for rejected or non-slash input", async () => {
    const recorded: string[] = []
    const dispatch = makeDispatch((token) => recorded.push(token))
    expect(await dispatch.dispatch("/nope")).toBe(false)
    expect(await dispatch.dispatch("plain text")).toBe(false)
    expect(recorded).toEqual([])
  })

  it("records accepted usage and observes transport rejection", async () => {
    const rejected = Promise.withResolvers<{ ok: true }>()
    const dispatch = mock(() => dispatch.mock.calls.length === 1 ? Promise.resolve({ ok: true as const }) : rejected.promise)
    const recordUsage = createCommandUsageRecorder({ dispatch: runtimeDispatch({ "command_usage.record": dispatch }) })

    recordUsage("exit")
    recordUsage("quit")
    rejected.reject(new Error("transport closed"))
    await Promise.resolve()

    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "command_usage.record", name: "exit" })
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "command_usage.record", name: "quit" })
  })
})

describe("dispatch before the command catalog arrives", () => {
  function makeEarlyDispatch() {
    const context = Object.freeze({ marker: Symbol("early context") })
    const ran: string[] = []
    const published = { spec: { id: "doctor", title: "Doctor", description: "Check this machine" }, execute: () => { ran.push("doctor"); return true } }
    let definitions: readonly BuiltInCommandDefinition<typeof context>[] = []
    let known = false
    const arrival = Promise.withResolvers<void>()
    const toasts: string[] = []
    const dispatch = createCommandDispatch({
      definitions: () => definitions,
      context,
      showToast: (toast) => { toasts.push(toast.message) },
      offCommands: () => [],
      catalog: { known: () => known, arrived: arrival.promise },
    })
    return {
      dispatch,
      ran,
      toasts,
      arrive: () => { definitions = [published]; known = true; arrival.resolve() },
    }
  }

  it("runs a published command typed before the catalog once the catalog arrives, and never calls it unknown", async () => {
    const early = makeEarlyDispatch()
    const settling = early.dispatch.dispatch("/doctor")
    await flush()
    expect(early.toasts).toEqual([])
    early.arrive()
    expect(await settling).toBe(true)
    expect(early.ran).toEqual(["doctor"])
    expect(early.toasts).toEqual([])
  })

  it("calls a token unknown only once the catalog is known", async () => {
    const early = makeEarlyDispatch()
    const settling = early.dispatch.dispatch("/nope")
    await flush()
    expect(early.toasts).toEqual([])
    early.arrive()
    expect(await settling).toBe(false)
    expect(early.toasts).toEqual(["Unknown command. Try /help"])
  })
})

const PUBLISHED: readonly BuiltInCommandDescriptor[] = [
  { id: "bg", title: "Background work", description: "Manage background work", aliases: ["tasks"] },
  { id: "fork", title: "Fork conversation", description: "Fork this chat", aliases: [] },
  { id: "papercuts", title: "Papercuts", description: "Drain project papercuts", aliases: [] },
  { id: "learn", title: "Learn", description: "Run the learning review", aliases: ["reflect"] },
  { id: "unheard-of", title: "Synthetic", description: "Published by a module this client never imported", aliases: [] },
]

/** The slice of the shell context one runtime-bound command reads, with the
 *  runtime's answer scripted per invocation. */
function commandContext(outcome: CommandOutcome, overrides: { sessionKind?: "chat" | "message" } = {}) {
  const dispatch = mock(async (_command: FrontendMutation) => outcome)
  const fakes = {
    showToast: mock(() => {}),
    openSurface: mock((_surface: string, _request?: SurfaceRequest): boolean | Promise<boolean> => true),
    focusSession: mock(() => {}),
    refreshCommandCatalog: mock(async () => {}),
  }
  const signals = { sessionInputMode: () => ({ kind: overrides.sessionKind ?? "chat" }), foregroundId: () => "chat-1", commandCatalogRevision: () => 4 }
  const context = testCommandContext({
    ...fakes,
    signals,
    appService: { dispatch: runtimeDispatch({ "command.invoke": dispatch }) },
    captureSurfaceOpener: createSurfaceOpener({ sessionId: signals.foregroundId, placement: () => 0, surfaces: () => [], openSurface: (surface, isCurrent) => fakes.openSurface(surface, { isCurrent }) }),
  })
  return { context, dispatch, ...fakes }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("runtime command bindings", () => {
  it("retains placement and presentation intent across delayed opens", async () => {
    const [definition] = bindRuntimeCommandDefinitions(PUBLISHED, () => "")
    if (!definition) throw new Error("expected a bound definition")
    for (const scenario of ["matching", "switch", "return", "modal", "viewer", "invocation", "global", "mismatch"] as const) {
      const gate = Promise.withResolvers<CommandOutcome>()
      const harness = commandContext({ kind: "none" })
      let sessionId = "chat-1"
      let revision = 0
      const overlay = createOverlayLayers()
      const captureSurfaceOpener = createSurfaceOpener({
        sessionId: () => sessionId, placement: () => revision,
        surfaces: () => [overlay.dialog.stack, overlay.viewer.stack],
        openSurface: (surface, isCurrent) => harness.openSurface(surface, { isCurrent }),
      })
      Object.assign(harness.context, { captureSurfaceOpener })
      harness.dispatch.mockImplementationOnce(() => gate.promise)
      const running = definition.execute(harness.context, undefined)
      if (scenario === "switch" || scenario === "return" || scenario === "global") { sessionId = "chat-2"; revision++ }
      if (scenario === "return") { sessionId = "chat-1"; revision++ }
      if (scenario === "modal") overlay.dialog.replace(undefined)
      if (scenario === "viewer") overlay.viewer.push(undefined)
      if (scenario === "invocation") await definition.execute(harness.context, undefined)
      gate.resolve({ kind: "open", surface: "background", ...(scenario === "global" ? {} : { sessionId: scenario === "mismatch" ? "chat-2" : "chat-1" }) })
      expect(await running).toBe(true)
      expect(harness.openSurface.mock.calls.length).toBe(scenario === "matching" || scenario === "global" ? 1 : 0)
    }
  })
  it("binds every published descriptor to one invocation, by id, with no command-id table", async () => {
    const definitions = bindRuntimeCommandDefinitions(PUBLISHED, () => "")
    expect(definitions.map((definition) => definition.spec.id)).toEqual(PUBLISHED.map((command) => command.id))
    for (const [index, definition] of definitions.entries()) {
      const { context, dispatch } = commandContext({ kind: "none" })
      expect(await definition.execute(context, "exact argument")).toBe(true)
      await flush()
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: PUBLISHED[index]?.id, revision: 4, sessionId: "chat-1", argument: "exact argument" })
    }
  })

  it("names no session outside a chat and omits an absent argument", async () => {
    const [definition] = bindRuntimeCommandDefinitions(PUBLISHED, () => "")
    if (!definition) throw new Error("expected a bound definition")
    const { context, dispatch } = commandContext({ kind: "none" }, { sessionKind: "message" })
    await definition.execute(context, undefined)
    await flush()
    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "bg", revision: 4 })
  })

  it("presents each closed outcome through its one affordance", async () => {
    const [definition] = bindRuntimeCommandDefinitions(PUBLISHED, () => "")
    if (!definition) throw new Error("expected a bound definition")
    const run = async (outcome: CommandOutcome) => {
      const harness = commandContext(outcome)
      const accepted = await definition.execute(harness.context, undefined)
      await flush()
      return { ...harness, accepted }
    }
    expect((await run({ kind: "message", message: "hello" })).showToast).toHaveBeenCalledWith({ message: "hello", variant: "info" })
    expect((await run({ kind: "warning", message: "careful" })).showToast).toHaveBeenCalledWith({ message: "careful", variant: "warning" })
    const unavailable = await run({ kind: "unavailable", message: "gone" })
    expect(unavailable.showToast).toHaveBeenCalledWith({ message: "gone", variant: "warning" })
    expect(unavailable.accepted).toBe(false)
    expect((await run({ kind: "open", surface: "background" })).openSurface).toHaveBeenCalledWith("background", { isCurrent: expect.any(Function) })
    expect((await run({ kind: "focus-session", sessionId: "chat-2" })).focusSession).toHaveBeenCalledWith("chat-2")
    const stale = await run({ kind: "stale" })
    expect(stale.refreshCommandCatalog).toHaveBeenCalledTimes(1)
    expect(stale.showToast).toHaveBeenCalledWith({ message: "Commands changed, try again", variant: "warning" })
    expect(stale.accepted).toBe(false)
    const none = await run({ kind: "none" })
    expect(none.accepted).toBe(true)
    expect(none.showToast).not.toHaveBeenCalled()
    expect(none.openSurface).not.toHaveBeenCalled()
    expect(none.focusSession).not.toHaveBeenCalled()
  })

  it("imports no orchestration module composition", async () => {
    const source = await Bun.file(fileURLToPath(new URL("../../../../src/tui/commands/runtime-command-bindings.ts", import.meta.url))).text()
    expect(source).not.toContain("orchestration/modules")
    expect(source).not.toContain("composeFirstPartyModules")
  })
})
