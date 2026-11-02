/**
 * Tests for Phase 6: Chat as Default Landing Experience
 *
 * 6.1 — /new closes current session and starts fresh
 * 6.2 — Free text in chat goes to sendMessage(), not command registry
 */

import { afterEach, describe, it, expect, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"


import { commandsToOptions, commandSpecs } from "../../../src/tui/commands/command-catalog.js"
import { buildCommandCatalog, publishedCommands } from "../../helpers/command-catalog.js"
import { buildCommandDefinitions } from "../../../src/tui/commands/command-definitions.js"
import { createCommandDispatch } from "../../../src/tui/commands/command-dispatch.js"
import { useCommands, type CommandDeps } from "../../../src/tui/hooks/use-commands.js"
import type { BuiltInCommandDescriptor, OffCommandDescriptor, RuntimeCommandInvocation } from "../../../src/protocol/command-catalog-protocol-types.js"
import type { ChatInput } from "../../../src/infra/chat-input.js"
import { createSessionCreator, type SessionCreator } from "../../../src/tui/hooks/create-session-creator.js"
import { createDraftCache } from "../../../src/tui/hooks/create-draft-cache.js"
import { createTabState } from "../../../src/tui/hooks/create-tabs.js"
import type { ForegroundTarget, ShellServices, ShellSignals } from "../../../src/tui/hooks/shell-state.js"
import type { FrontendMutation, MutationResult } from "../../../src/protocol/app-service-types.js"
import { testCommandContext } from "../../helpers/command-context.js"
import { recordedDispatch, runtimeDispatch } from "../../helpers/runtime-dispatch.js"

const BG_COMMAND = { id: "bg", title: "Background work", description: "Manage background commands", aliases: ["tasks"], opens: "background" } as const
const FORK_COMMAND = { id: "fork", title: "Fork conversation", description: "Fork the active conversation into a new chat", aliases: [] } as const
const REFLECT_COMMAND = { id: "learn", title: "Learn", description: "Run review", aliases: [] } as const
interface HarnessOverrides {
  showToast?: ShellServices["showToast"]
  signals?: Partial<Pick<ShellSignals, "foregroundId" | "foregroundTarget" | "sessionInputMode" | "commandCatalogRevision">>
  sendMessage?: CommandDeps["sendMessage"]
  startChat?: SessionCreator["startChat"]
  /** Answers the runtime command invocations that built-in commands dispatch. */
  invoke?: (command: RuntimeCommandInvocation) => Promise<MutationResult<RuntimeCommandInvocation>>
  builtInCommands?: () => readonly BuiltInCommandDescriptor[]
  offCommands?: () => readonly OffCommandDescriptor[]
}

/** Builds the production pair: a command dispatch (routing) with the built-in
 *  executions registered by useCommands (binding). `deps` carries the mocks
 *  the expectations read, and `runtimeMutations` records the runtime mutations. */
function createHarness(overrides: HarnessOverrides = {}) {
  const signals = {
    foregroundId: (): string | undefined => "chat-abc",
    foregroundTarget: (): ForegroundTarget | undefined => ({ kind: "session", sessionId: "chat-abc" }),
    sessionInputMode: () => ({ kind: "chat" as const }),
    commandCatalogRevision: () => 1,
    ...overrides.signals,
  }
  const runtimeMutations = mock((_command: FrontendMutation) => {})
  const dispatch = recordedDispatch(runtimeMutations, runtimeDispatch(overrides.invoke ? { "command.invoke": overrides.invoke } : {}))
  const context = testCommandContext({
    signals,
    appService: { dispatch },
    showToast: overrides.showToast ?? mock(() => {}),
  })
  const deps = {
    ...context,
    openSettingsDestination: mock(async () => {}),
    signals,
    sendMessage: overrides.sendMessage ?? mock(async () => {}),
    startChat: overrides.startChat ?? mock(async () => ({ kind: "foregrounded" as const, sessionId: "new-chat" })),
    providerSetup: () => "usable" as const,
    openSubscriptionSpendReview: () => false,
  }
  const definitions = () => buildCommandDefinitions(() => "ctrl+x", overrides.builtInCommands?.() ?? publishedCommands())
  const commandDispatch = createCommandDispatch({
    definitions,
    context,
    showToast: context.showToast,
    offCommands: overrides.offCommands ?? (() => []),
    catalog: { known: () => true, arrived: Promise.resolve() },
  })
  const commands = useCommands({ ...deps, dispatch: commandDispatch })
  return {
    deps,
    runtimeMutations,
    handleComposerSubmit: commands.handleComposerSubmit,
    dispatchSlashCommand: (text: string) => { void commandDispatch.dispatch(text) },
    completableNames: commandDispatch.completableNames,
  }
}

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function createLandingHarness(id?: string, mode: "chat" | null = null) {
  return createRoot((dispose) => {
    disposers.push(dispose)
    const request = Promise.withResolvers<{ ok: true; sessionId: string } | { ok: false; error: string }>()
    const entered = Promise.withResolvers<void>()
    const [foregroundTarget, setForegroundTarget] = createSignal<ForegroundTarget | undefined>(id ? { kind: "session", sessionId: id } : undefined)
    const signals = {
      foregroundTarget,
      setForegroundTarget,
      foregroundId: () => { const target = foregroundTarget(); return target?.kind === "session" ? target.sessionId : undefined },
      setForegroundId: (sessionId: string | undefined) => setForegroundTarget(sessionId ? { kind: "session", sessionId } : undefined),
      sessionInputMode: () => mode === "chat" ? { kind: "chat" as const } : null,
      sessionState: () => null,
      sessionShortTitle: () => "",
      statusView: () => undefined,
      questionView: () => undefined,
      outputView: () => undefined,
    }
    const draftCache = createDraftCache()
    const tabs = createTabState({ signals, sessions: () => [] })
    const dispatch = mock((_command: Extract<FrontendMutation, { type: "chat.open" }>) => { entered.resolve(); return request.promise })
    let settlement: ReturnType<SessionCreator["startChat"]> | undefined
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const h = createHarness({ signals, showToast, startChat: (input) => { settlement = creator.startChat(input); return settlement } })
    const creator = createSessionCreator({
      signals, appService: { dispatch }, ...tabs, draftCache, adoptDraft: draftCache.adopt,
      seedSessionCatalogRow: () => {}, startKnownEmptyTranscript: () => {}, retireTransientSession: () => {},
      showToast,
    })
    return { ...h, showToast, creator, signals, draftCache, tabs, dispatch, request, entered: entered.promise, settled: () => settlement! }
  })
}

describe("Chat as Default Landing — /new command", () => {
  it("/new opens the catalog's new-chat surface", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("/new")

    expect(deps.openSurface).toHaveBeenCalledWith("new-chat", {})
  })

  it("/clear routes to the teaching fresh-tab path, not /new", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("/clear")

    expect(deps.startClearedChat).toHaveBeenCalledTimes(1)
    expect(deps.openSurface).not.toHaveBeenCalled()
  })

  it("hides /clear from visible rosters while keeping it completable", () => {
    const catalog = buildCommandCatalog(() => "ctrl+x", [BG_COMMAND, REFLECT_COMMAND])
    expect(commandsToOptions(catalog).some((option) => option.id === "clear")).toBe(false)

    const { completableNames } = createHarness()
    expect(completableNames()).toContain("clear")
  })

  it("lists each command once under its own token, its aliases beside it, and no alias row", () => {
    const catalog = buildCommandCatalog(() => "ctrl+x", [BG_COMMAND, REFLECT_COMMAND])
    const byId = new Map(commandsToOptions(catalog).map((option) => [option.id, option]))

    const exit = byId.get("exit")
    if (exit === undefined) throw new Error("the exit row is missing")
    expect([exit.value, exit.footer]).toEqual(["/exit", "/exit /quit"])
    expect(byId.has("quit")).toBe(false)
  })

  it.each(["/exit", "/quit"])("%s exits the client without closing its shared foreground session", (command) => {
    const { deps, runtimeMutations, handleComposerSubmit } = createHarness()

    handleComposerSubmit(command)

    expect(deps.exit).toHaveBeenCalledWith()
    expect(runtimeMutations).not.toHaveBeenCalled()
  })

})

describe("no-session commands", () => {
  it("opens status without a foreground session", () => {
    const { deps, handleComposerSubmit } = createHarness({ signals: { foregroundId: () => undefined, sessionInputMode: () => null } })

    handleComposerSubmit("/status")

    expect(deps.openSurface).toHaveBeenCalledWith("status", {})
    expect(deps.showToast).not.toHaveBeenCalled()
  })
})

describe("resumed session prompt routing", () => {
  it("routes from the catalog input mode before the detailed session view loads", () => {
    const sendMessage = mock(async () => {})
    const { handleComposerSubmit, runtimeMutations } = createHarness({ sendMessage })

    const accepted = handleComposerSubmit("resume safely")

    expect(accepted).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith("chat-abc", { text: "resume safely" })
    expect(runtimeMutations).not.toHaveBeenCalled()
  })
})

describe("Model selection command", () => {
  it("/model opens Models and /effort opens Model and effort of the transcript in view", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("/model")
    handleComposerSubmit("/effort")

    expect(deps.openSurface).toHaveBeenNthCalledWith(1, "models", {})
    expect(deps.openSurface).toHaveBeenNthCalledWith(2, "models", { target: { kind: "transcript-in-view" } })
  })

  it("/auth opens Settings at Authentication, and /find passes its query to the surface", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("/login")
    handleComposerSubmit("/find some words")

    expect(deps.openSurface).toHaveBeenNthCalledWith(1, "settings", { target: { kind: "place", place: "authentication" } })
    expect(deps.openSurface).toHaveBeenNthCalledWith(2, "find", { argument: "some words" })
  })

  it("/font reports usage for unknown font actions", async () => {
    const showToast = mock(() => {})
    const { handleComposerSubmit } = createHarness({ showToast })

    handleComposerSubmit("/font nope")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(showToast).toHaveBeenCalledWith({
      message: "Usage: /font status|install|dismiss|reset",
      variant: "warning",
    })
  })

  it("/help opens Commands, /shortcuts Keyboard shortcuts, and /settings Settings", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("/help")
    handleComposerSubmit("/shortcuts")
    handleComposerSubmit("/settings")

    expect(deps.openSurface).toHaveBeenNthCalledWith(1, "commands", {})
    expect(deps.openSurface).toHaveBeenNthCalledWith(2, "keyboard-shortcuts", {})
    expect(deps.openSurface).toHaveBeenNthCalledWith(3, "settings", {})
  })

  it("/compact runs in the runtime and shows its warning when no chat history is available", async () => {
    const showToast = mock(() => {})
    const dispatch = mock(async () => ({ kind: "warning" as const, message: "No active context to compact yet" }))
    const { handleComposerSubmit } = createHarness({ showToast, invoke: dispatch })

    handleComposerSubmit("/compact")
    await new Promise((r) => setTimeout(r, 10))

    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "compact", revision: 1, sessionId: "chat-abc" })
    expect(showToast).toHaveBeenCalledWith({ message: "No active context to compact yet", variant: "warning" })
  })
})

describe("a command only a turned-off module provides", () => {
  it("answers the shared refusal that names the module, never Unknown command, by id or alias", async () => {
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const harness = createHarness({ showToast, builtInCommands: () => [FORK_COMMAND], offCommands: () => [
      { id: "bg", aliases: ["tasks"], modules: ["Background Commands", "Subagents", "Workflows"] },
      { id: "mcp", aliases: [], modules: ["MCP servers"] },
    ] })

    for (const text of ["/tasks", "/MCP"]) harness.handleComposerSubmit(text)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.runtimeMutations).not.toHaveBeenCalled()
    expect(showToast.mock.calls).toEqual([
      [{ message: '"/tasks" needs one of the Background Commands, Subagents, or Workflows modules, which are off. Turn one on in Settings.', variant: "warning" }],
      [{ message: '"/mcp" needs the MCP servers module, which is off. Turn it on in Settings.', variant: "warning" }],
    ])
  })
})

describe("runtime-published Learn availability", () => {
  it("hides Reflect from rosters and completion while the runtime publishes none", () => {
    const [available, setAvailable] = createSignal(false)
    const builtInCommands = () => available() ? [BG_COMMAND, REFLECT_COMMAND] as const : [BG_COMMAND] as const
    const catalog = () => buildCommandCatalog(() => "ctrl+x", builtInCommands())
    const harness = createHarness({ builtInCommands })

    expect(commandsToOptions(catalog()).some((option) => option.id === "learn")).toBe(false)
    expect(harness.completableNames()).not.toContain("learn")
    setAvailable(true)
    expect(commandsToOptions(catalog()).some((option) => option.id === "learn")).toBe(true)
    expect(harness.completableNames()).toContain("learn")
  })

  it("reports the runtime's own refusal when Learn is typed directly", async () => {
    const showToast = mock(() => {})
    // The TUI makes no capability decision: it invokes the command and renders
    // whatever the runtime, which owns admission, answered.
    const dispatch = mock(async () => ({ kind: "warning" as const, message: "Learning is disabled" }))
    const { handleComposerSubmit } = createHarness({ showToast, invoke: dispatch, builtInCommands: () => [BG_COMMAND, REFLECT_COMMAND] })

    handleComposerSubmit("/learn")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "learn", revision: 1, sessionId: "chat-abc" })
    expect(showToast).toHaveBeenCalledWith({ message: "Learning is disabled", variant: "warning" })
  })
})

describe("runtime-published kernel commands", () => {
  it("adds exactly one fork row only after the runtime publishes its descriptor", () => {
    const withoutFork = commandSpecs(buildCommandDefinitions(() => "ctrl+x", [BG_COMMAND]))
    const withFork = commandSpecs(buildCommandDefinitions(() => "ctrl+x", [BG_COMMAND, FORK_COMMAND]))

    expect(commandsToOptions(withoutFork).filter((option) => option.id === "fork")).toHaveLength(0)
    expect(commandsToOptions(withFork).filter((option) => option.id === "fork")).toHaveLength(1)
  })

  it("executes discovered fork as one runtime invocation and foregrounds the session it answers", async () => {
    const dispatch = mock(async () => ({ kind: "focus-session" as const, sessionId: "chat-fork" }))
    const { deps, handleComposerSubmit } = createHarness({ invoke: dispatch, builtInCommands: () => [FORK_COMMAND] })

    handleComposerSubmit("/fork")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "fork", revision: 1, sessionId: "chat-abc" })
    expect(deps.focusSession).toHaveBeenCalledWith("chat-fork")
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

  it("names no session for fork outside a chat and shows the runtime's warning", async () => {
    const showToast = mock(() => {})
    const dispatch = mock(async () => ({ kind: "warning" as const, message: "No active chat session" }))
    const { deps, handleComposerSubmit } = createHarness({
      showToast,
      invoke: dispatch,
      builtInCommands: () => [FORK_COMMAND],
      signals: { sessionInputMode: () => null },
    })

    handleComposerSubmit("/fork")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "fork", revision: 1 })
    expect(deps.focusSession).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith({ message: "No active chat session", variant: "warning" })
  })

})

describe("Chat as Default Landing — free text routing", () => {
  it("empty text is ignored", () => {
    const { deps, handleComposerSubmit } = createHarness()

    handleComposerSubmit("")
    handleComposerSubmit("   ")

    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    { name: "no foreground", id: undefined, mode: null, input: { text: "hello" } },
    { name: "chat mode without an id", id: undefined, mode: "chat", input: { text: "hello" } },
    { name: "attachment only", id: undefined, mode: null, input: { text: "", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n" }] } },
    { name: "slash text with an attachment", id: undefined, mode: null, input: { text: "/describe [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n" }] } },
  ] satisfies Array<{ name: string; id: string | undefined; mode: "chat" | null; input: ChatInput }>)("creates and delivers once for $name", async ({ id, mode, input }) => {
    const h = createLandingHarness(id, mode)

    expect(h.handleComposerSubmit(input)).toBe(true)
    // Composer clears the accepted buffer before creation changes its owner.
    expect(h.signals.foregroundTarget()).toEqual(id ? { kind: "session", sessionId: id } : undefined)
    await h.entered
    expect(h.dispatch.mock.calls).toEqual([[{ type: "chat.open", initialMessage: input }]])
    expect(h.signals.foregroundTarget()?.kind).toBe("pending")
    expect(h.deps.sendMessage).not.toHaveBeenCalled()

    h.request.resolve({ ok: true, sessionId: "created" })
    expect(await h.settled()).toEqual({ kind: "foregrounded", sessionId: "created" })
    expect(h.signals.foregroundId()).toBe("created")
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.deps.sendMessage).not.toHaveBeenCalled()
    expect(h.deps.showToast).not.toHaveBeenCalled()
    expect(h.creator.recallFailedChat()).toBeNull()
  })

  it("delivers to the selected id while its detail is unavailable instead of creating another chat", () => {
    const h = createLandingHarness("selected", null)
    expect(h.handleComposerSubmit("hello")).toBe(true)
    expect(h.deps.sendMessage).toHaveBeenCalledWith("selected", { text: "hello" })
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.signals.foregroundId()).toBe("selected")
  })

  it.each([false, true])("retains a failed initial message without clearing a newer draft or focus (navigated: %s)", async (navigated) => {
    const h = createLandingHarness()
    const input: ChatInput = { text: "inspect [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n" }] }
    expect(h.handleComposerSubmit(input)).toBe(true)
    await h.entered
    if (navigated) {
      h.signals.setForegroundId("later-chat")
      h.draftCache.set("later-chat", { text: "newer draft", pastes: [], attachments: [] })
    }

    h.request.resolve({ ok: false, error: "cannot create" })
    expect(await h.settled()).toEqual({ kind: "failed" })
    expect(h.signals.foregroundId()).toBe(navigated ? "later-chat" : undefined)
    if (navigated) expect(h.draftCache.get("later-chat").text).toBe("newer draft")
    expect(h.creator.recallFailedChat()).toEqual(input)
    expect(h.creator.recallFailedChat()).toBeNull()
    expect(h.showToast.mock.calls).toEqual([[{ message: "cannot create. Press Up in an empty prompt to restore your message.", variant: "error" }]])
    expect(h.deps.sendMessage).not.toHaveBeenCalled()
  })
})

describe("completableNames from descriptor projections", () => {
  it("includes static commands and aliases", () => {
    const { completableNames } = createHarness()
    const names = completableNames()
    expect(names).toContain("help")
    expect(names).toContain("exit")
    expect(names).toContain("quit")
    expect(names).toContain("sessions")
    expect(names).toContain("model")
    expect(names).toContain("settings")
  })
})

describe("dispatchSlashCommand (palette-safe path)", () => {
  it("runs a slash command without going through handleComposerSubmit", () => {
    const { deps, dispatchSlashCommand } = createHarness()

    dispatchSlashCommand("/help")

    expect(deps.openSurface).toHaveBeenCalledWith("commands", {})
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })

})

describe("Chat as Default Landing — unknown command toast", () => {
  it("unknown commands outside chat show updated toast text (no /chat reference)", async () => {
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const { handleComposerSubmit } = createHarness({
      signals: { sessionInputMode: () => null },
      showToast,
    })

    handleComposerSubmit("/bogus")

    await new Promise((r) => setTimeout(r, 10))

    expect(showToast).toHaveBeenCalledTimes(1)
    const message = showToast.mock.calls[0]?.[0].message
    expect(message).not.toContain("/chat")
    expect(message).toContain("/help")
  })
})
