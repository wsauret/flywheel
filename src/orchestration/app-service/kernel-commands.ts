import type { BuiltInCommandDescriptor, CommandOutcome, CommandSurfaceTarget, KernelSurface, OffCommandDescriptor } from "../../protocol/command-catalog-protocol-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"
import type { ModuleHealthCheck } from "../module-health.js"
import type { FirstPartyModuleComposition, ModuleCommandIdentity, ModuleCommandMetadata } from "../modules.js"
import type { CommandHost } from "./command-host.js"

type KernelCommand = ModuleCommandIdentity & {
  /** The modules that give this command something to act on; it runs while
   *  any one of them is on. Absent for a command that always runs. */
  readonly providers?: (modules: FirstPartyModuleComposition) => readonly string[]
} & (
  /** Runs against the composition that published the command. */
  | { readonly execute: (host: CommandHost, argument: string | undefined, modules: FirstPartyModuleComposition) => Promise<CommandOutcome> }
  | { readonly opens: KernelSurface; readonly target?: CommandSurfaceTarget }
)

/** The health checks of every enabled module, in publication order. */
function healthChecks(modules: FirstPartyModuleComposition): readonly ModuleHealthCheck[] {
  return modules.contributions.flatMap((contribution) => contribution.domain === "health" ? [contribution.value] : [])
}

/** Runs every enabled module's health check and joins the sections into one report. A check that fails states its
 *  failure as its section, so one broken check never hides the others. */
async function doctorReport(host: CommandHost, modules: FirstPartyModuleComposition): Promise<CommandOutcome> {
  const sections = await Promise.all(healthChecks(modules).map(async ({ title, check }) => {
    try {
      return { title, ...await check(host) }
    } catch (error) {
      return { title, attention: true, lines: [`The check failed: ${errorMessage(error)}`] }
    }
  }))
  const message = sections.map(({ title, lines }) => [title, ...lines.map((line) => `  ${line}`)].join("\n")).join("\n")
  return { kind: sections.some(({ attention }) => attention) ? "warning" : "message", message }
}

const top = (rank: number) => ({ group: "top", rank }) as const
const chat = (rank: number) => ({ group: "chat", rank }) as const

/** The commands the kernel itself contributes, declared in the module command
 *  shape so the catalog and the invoke service treat them like any other. They
 *  stay kernel because they act on session lifecycle and client chrome, not on
 *  a selectable capability. Menu ranks interleave with the ranks modules give
 *  their own commands. */
const KERNEL_COMMANDS: readonly KernelCommand[] = [
  { id: "model-and-effort", title: KERNEL_COMMAND_NAMES["model-and-effort"], description: "Choose the model and effort of the conversation in view", aliases: ["effort"], menu: top(20), opens: "models", target: { kind: "transcript-in-view" } },
  { id: "model", title: KERNEL_COMMAND_NAMES.model, description: "Choose each role's model and effort", aliases: [], menu: top(30), opens: "models" },
  { id: "auth", title: KERNEL_COMMAND_NAMES.auth, description: "Sign in to a model provider, add an API key, or review paid use", aliases: ["login"], menu: top(40), opens: "settings", target: { kind: "place", place: "authentication" } },
  { id: "settings", title: KERNEL_COMMAND_NAMES.settings, description: "Change how Flywheel looks and works", aliases: ["config"], menu: top(50), opens: "settings" },
  {
    id: "bg",
    title: KERNEL_COMMAND_NAMES.bg,
    description: "Show the work this chat runs in the background",
    aliases: ["tasks"],
    menu: top(70),
    providers: (modules) => modules.backgroundWorkProducerIds,
    opens: "background",
  },
  { id: "status", title: KERNEL_COMMAND_NAMES.status, description: "Version, model, account, and connection health", aliases: [], menu: top(100), opens: "status" },
  { id: "profile", title: KERNEL_COMMAND_NAMES.profile, description: "Switch the auth profile, or name a profile to switch to it at once", aliases: [], menu: top(110), opens: "auth-profiles" },
  {
    id: "doctor",
    title: KERNEL_COMMAND_NAMES.doctor,
    description: "Check what Flywheel needs from this machine and report what to repair",
    aliases: [],
    menu: top(120),
    providers: (modules) => [...new Set(modules.installedContributions.flatMap((contribution) => contribution.domain === "health" ? [contribution.module] : []))],
    execute: (host, _argument, modules) => doctorReport(host, modules),
  },
  { id: "shortcuts", title: KERNEL_COMMAND_NAMES.shortcuts, description: "Show the keyboard shortcut reference", aliases: ["hotkeys", "keybindings"], menu: top(140), opens: "keyboard-shortcuts" },
  { id: "new", title: KERNEL_COMMAND_NAMES.new, description: "Start a new chat session", aliases: [], menu: chat(10), opens: "new-chat" },
  { id: "sessions", title: KERNEL_COMMAND_NAMES.sessions, description: "Manage sessions", aliases: [], menu: chat(20), opens: "sessions" },
  { id: "changes", title: KERNEL_COMMAND_NAMES.changes, description: "Review the file changes of this session and the agents it launched, and undo them per file", aliases: [], menu: chat(30), opens: "changes" },
  {
    id: "compact",
    title: KERNEL_COMMAND_NAMES.compact,
    description: "Compact the conversation context",
    aliases: [],
    menu: chat(40),
    reading: "context-window",
    execute: async (host) => {
      if (!host.session) return { kind: "warning", message: "No active chat session" }
      return await host.session.compact() ? { kind: "none" } : { kind: "warning", message: "No active context to compact yet" }
    },
  },
  { id: "resume", title: KERNEL_COMMAND_NAMES.resume, description: "Continue an interrupted session from where it stopped", aliases: [], menu: chat(50), opens: "resume" },
  { id: "attach", title: KERNEL_COMMAND_NAMES.attach, description: "Pick files or photos on this computer to send with your message", aliases: [], menu: chat(60), opens: "attach-files" },
  { id: "find", title: KERNEL_COMMAND_NAMES.find, description: "Search the words of this chat or every chat, starting with any words that follow the command", aliases: ["search"], menu: chat(70), opens: "find" },
  {
    id: "fork",
    title: KERNEL_COMMAND_NAMES.fork,
    description: "Fork the active conversation into a new chat",
    aliases: [],
    execute: async (host) => {
      if (!host.session) return { kind: "warning", message: "No active chat session" }
      return { kind: "focus-session", sessionId: await host.session.fork() }
    },
  },
  // A client surface, not a handler: Close chat is the published session.close
  // that every client already sends, so it never waits behind a command of
  // the chat and works while the project's runtime is paused.
  { id: "close", title: KERNEL_COMMAND_NAMES.close, description: "End this chat's work now and close it; Resume can continue its turn", aliases: [], menu: chat(80), opens: "close-chat" },
  { id: "help", title: KERNEL_COMMAND_NAMES.help, description: "List every command", aliases: [], opens: "commands", menu: { group: "more", rank: 10 } },
]

function isOn(command: KernelCommand, modules: FirstPartyModuleComposition): boolean {
  return command.providers === undefined || command.providers(modules).some((id) => modules.enabledModuleIds.includes(id))
}

/** Kernel commands plus every command an enabled module contributes, in
 *  publication order: every command that runs now. This is the one roster
 *  both the catalog descriptors and command invocation read, so a command
 *  executes from exactly the composition that published it. */
export function builtInCommandDeclarations(modules: FirstPartyModuleComposition): readonly ModuleCommandMetadata[] {
  const kernel = KERNEL_COMMANDS.filter((command) => isOn(command, modules)).map(({ providers: _providers, ...command }): ModuleCommandMetadata => {
    if ("opens" in command) return command
    const { execute, ...identity } = command
    return { ...identity, execute: (host, argument) => execute(host, argument, modules) }
  })
  const contributed = modules.contributions.flatMap((contribution) => contribution.domain === "commands" ? [contribution.value] : [])
  return [...kernel, ...contributed]
}

/** Every command that only a turned-off module provides, with the Settings
 *  names of those modules: a kernel command whose providers are all off, and
 *  each command an installed but disabled module contributes. */
export function offCommandDescriptors(modules: FirstPartyModuleComposition): readonly OffCommandDescriptor[] {
  const label = (moduleId: string): string => {
    for (const contribution of modules.installedContributions) {
      if (contribution.module !== moduleId || contribution.domain !== "settings") continue
      if (contribution.value.control === "binary" || contribution.value.control === "workflow-mode") return contribution.value.label
    }
    return moduleId
  }
  // A command no installed module provides is not off, only absent.
  const kernel = KERNEL_COMMANDS.flatMap(({ id, aliases, providers }) => {
    const installed = providers?.(modules) ?? []
    return installed.length > 0 && !installed.some((moduleId) => modules.enabledModuleIds.includes(moduleId))
      ? [{ id, aliases, modules: installed.map(label) }]
      : []
  })
  const contributed = modules.installedContributions.flatMap((contribution) =>
    contribution.domain === "commands" && !modules.enabledModuleIds.includes(contribution.module)
      ? [{ id: contribution.value.id, aliases: contribution.value.aliases, modules: [label(contribution.module)] }]
      : [])
  return [...kernel, ...contributed]
}

export function builtInCommandDescriptor(command: ModuleCommandMetadata): BuiltInCommandDescriptor {
  const { id, title, description, aliases, menu, reading } = command
  return {
    id, title, description, aliases,
    ...("opens" in command ? { opens: command.opens, ...(command.target === undefined ? {} : { target: command.target }) } : {}),
    ...(menu === undefined ? {} : { menu }),
    ...(reading === undefined ? {} : { reading }),
  }
}
