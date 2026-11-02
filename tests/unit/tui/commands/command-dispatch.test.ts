import { describe, expect, it, mock } from "bun:test"
import type { BuiltInCommandDescriptor } from "../../../../src/protocol/command-catalog-protocol-types.js"
import { buildCommandDefinitions, type BuiltInCommandContext } from "../../../../src/tui/commands/command-definitions.js"
import type { BuiltInCommandDefinition } from "../../../../src/tui/commands/command-types.js"
import type { OpenSurface } from "../../../../src/tui/commands/command-surfaces.js"
import { createCommandDispatch } from "../../../../src/tui/commands/command-dispatch.js"
import type { CommandDeps } from "../../../../src/tui/hooks/use-commands.js"
import { useCommands } from "../../../../src/tui/hooks/use-commands.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { UNKNOWN_COMMAND_NOTICE } from "../../../../src/protocol/client/slash-route.js"
import { runtimeDispatch, type DispatchAnswers } from "../../../helpers/runtime-dispatch.js"
import type { ShellServices, ShellSignals } from "../../../../src/tui/hooks/shell-state.js"
import { createLauncherScope } from "../../../../src/infra/process-supervisor.js"

const BG_COMMAND = { id: "bg", title: "Background work", description: "Manage background commands", aliases: ["tasks"] } as const
const REFLECT_COMMAND = { id: "learn", title: "Reflect", description: "Run review", aliases: [] } as const
const NEW_COMMAND = { id: "new", title: "New chat", description: "Start a new chat session", aliases: [], opens: "new-chat" } as const

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const launcher = createLauncherScope({ spawnOwned: async () => { throw new Error("not used") }, adoptOwned: () => Promise.reject(new Error("no command is adopted here")) })

interface HarnessOverrides {
  showToast?: ShellServices["showToast"]
  sendMessage?: CommandDeps["sendMessage"]
  /** Answers the runtime mutations that commands dispatch. */
  answers?: DispatchAnswers
  openSurface?: OpenSurface
  builtInCommands?: readonly BuiltInCommandDescriptor[]
  agentInView?: BuiltInCommandContext["agentInView"]
}

/** Builds command routing with the same immutable context used by definitions. */
function createHarness(overrides: HarnessOverrides = {}) {
  const signals: Pick<ShellSignals, "foregroundId" | "foregroundTarget" | "sessionInputMode" | "commandCatalogRevision"> = {
    foregroundId: () => "chat-1",
    foregroundTarget: () => ({ kind: "session", sessionId: "chat-1" }),
    sessionInputMode: () => ({ kind: "chat" }),
    commandCatalogRevision: () => 1,
  }
  const showToast = overrides.showToast ?? mock(() => {})
  const appService = { dispatch: runtimeDispatch(overrides.answers ?? {}) }
  const openSurface = overrides.openSurface ?? mock(() => true)
  const context: BuiltInCommandContext = {
    directories: { accountHome: "/account", userDataRoot: "/account/.flywheel" },
    launcher,
    appService,
    runtimeConfig: { view: () => undefined, settlePublication: async () => false },
    showToast,
    signals,
    startClearedChat: mock(async () => {}),
    exit: mock(() => {}),
    restart: async () => { throw new Error("restart is not exercised") },
    openThemeModal: mock(() => {}),
    openSurface,
    captureSurfaceOpener: () => (surface: string) => openSurface(surface),
    focusSession: mock(() => {}),
    refreshCommandCatalog: mock(async () => {}),
    agentInView: overrides.agentInView ?? (() => undefined),
  }
  const commandDefinitions = buildCommandDefinitions(() => "ctrl+x", overrides.builtInCommands ?? [BG_COMMAND, REFLECT_COMMAND, NEW_COMMAND])
  const dispatch = createCommandDispatch({
    definitions: () => commandDefinitions,
    context,
    showToast,
    offCommands: () => [],
    catalog: { known: () => true, arrived: Promise.resolve() },
  })
  const commands = useCommands({
    signals,
    dispatch,
    showToast,
    sendMessage: overrides.sendMessage ?? mock(async () => {}),
    startChat: mock(async () => ({ kind: "foregrounded" as const, sessionId: "created" })),
    openSettingsDestination: mock(async () => {}),
    providerSetup: () => "usable" as const,
    openSubscriptionSpendReview: () => false,
  })
  return {
    submit: commands.handleComposerSubmit,
    dispatchSlashCommand: (text: string) => { void dispatch.dispatch(text) },
    completableNames: dispatch.completableNames,
  }
}

describe("slash dispatch", () => {
  it("answers a typed skill id, a learned skill, or a former skill alias as an unknown command, and sends nothing", async () => {
    const sent: FrontendMutation[] = []
    const sendMessage = mock(async () => {})
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const answers: DispatchAnswers = { "command.invoke": async (command) => { sent.push(command); return { kind: "none" } } }
    const { submit, completableNames } = createHarness({ sendMessage, showToast, answers })

    for (const typed of ["/design", "/learned.deploy-check", "/plan add a dark mode toggle"]) {
      const result = submit(typed)
      expect(typeof result === "object" ? await result.accepted : result).toBe(false)
    }

    expect(showToast.mock.calls.map(([toast]) => toast.message)).toEqual([UNKNOWN_COMMAND_NOTICE, UNKNOWN_COMMAND_NOTICE, UNKNOWN_COMMAND_NOTICE])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    for (const token of ["design", "learned.deploy-check", "plan"]) expect(completableNames()).not.toContain(token)
  })

  it.each(["subagent", "workflow-agent"] as const)("in a %s view, refuses a chat command before dispatch, opens a surface, and calls a stray token unknown", async (view) => {
    const invoked: FrontendMutation[] = []
    const answers: DispatchAnswers = {
      "command.invoke": async (command) => { invoked.push(command); return { kind: "open", surface: "background" } },
    }
    const openSurface = mock(() => true)
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const { dispatchSlashCommand } = createHarness({ answers, openSurface, showToast, agentInView: () => view })
    const named = view === "subagent" ? "subagent" : "workflow agent"

    for (const typed of ["/bg", "/new", "/xyzzy"]) dispatchSlashCommand(typed)
    await flush()

    expect(showToast.mock.calls.map(([toast]) => toast.message)).toEqual([`/bg works in a chat, not in this ${named}`, UNKNOWN_COMMAND_NOTICE])
    expect(openSurface).toHaveBeenCalledWith("new-chat", {})
    expect(invoked).toEqual([])
  })
})

describe("/bg dispatch", () => {
  it("invokes the runtime and opens the surface its outcome names", async () => {
    const openSurface = mock(() => true)
    const dispatch = mock(async (_command: FrontendMutation) => ({ kind: "open" as const, surface: "background" }))
    createHarness({ openSurface, answers: { "command.invoke": dispatch } }).dispatchSlashCommand("/bg")
    await flush()

    expect(dispatch).toHaveBeenCalledWith({ type: "command.invoke", id: "bg", revision: 1, sessionId: "chat-1" })
    expect(openSurface).toHaveBeenCalledWith("background")
  })

  it("omits bg from slash completion without its runtime descriptor", () => {
    expect(createHarness({ builtInCommands: [REFLECT_COMMAND] }).completableNames()).not.toContain("bg")
  })

  it("keeps bg out of slash completion but dispatchable while only turned-off modules provide it", () => {
    const commandDefinitions = buildCommandDefinitions(() => "ctrl+x", [REFLECT_COMMAND]).map(({ spec }) => ({ spec, execute: () => true })) satisfies readonly BuiltInCommandDefinition<undefined>[]
    const dispatch = createCommandDispatch({
      definitions: () => commandDefinitions,
      context: undefined,
      showToast: mock(() => {}),
      offCommands: () => [{ id: BG_COMMAND.id, aliases: BG_COMMAND.aliases, modules: ["Subagents"] }],
      catalog: { known: () => true, arrived: Promise.resolve() },
    })

    expect(dispatch.completableNames()).not.toContain("bg")
    expect(dispatch.dispatchableNames()).toContain("bg")
  })

  it("drops reflect from slash completion while the runtime projects no Learning review command", () => {
    const commandDefinitions = buildCommandDefinitions(() => "ctrl+x", [BG_COMMAND]).map(({ spec }) => ({ spec, execute: () => true })) satisfies readonly BuiltInCommandDefinition<undefined>[]
    const dispatch = createCommandDispatch({
      definitions: () => commandDefinitions,
      context: undefined,
      showToast: mock(() => {}),
      offCommands: () => [],
      catalog: { known: () => true, arrived: Promise.resolve() },
    })

    expect(dispatch.completableNames()).not.toContain("learn")
    expect(dispatch.dispatchableNames()).not.toContain("learn")
  })
})
