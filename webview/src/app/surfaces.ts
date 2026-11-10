import type { BuiltInCommandDescriptor, CommandReading as CommandReadingKind, CommandSurfaceTarget, KernelSurface, SurfacePlace } from "../../../src/protocol/command-catalog-protocol-types.js"
import type { SurfaceOpening } from "../../../src/protocol/client/surface-presentation.js"
import { commandMenuGroups } from "../../../src/protocol/client/command-menu.js"
import { compactionReading, compactionTrigger } from "../../../src/protocol/client/context-compaction.js"
import { isClientSheetId, type ClientSheetId } from "../../../src/protocol/client/host-contract.js"
import { describeUpdateStatus } from "../../../src/protocol/client/update-status-copy.js"
import { chatOnlyCommandNotice, UNKNOWN_COMMAND_NOTICE } from "../../../src/protocol/client/slash-route.js"
import { changesLabel } from "../client/changes-label.js"
import { summaryOf } from "../client/view-state.js"
import type { ClientContextValue } from "./client-context.js"

/** One place this client opens for a command, by the surface id the command
 *  catalog names (ARCH-PROTOCOL-037). Every command menu entry that opens a
 *  surface, the typed slash token, and an editor palette command land here. */
export interface WebSurface {
  readonly open: (opening?: SurfaceOpening) => void
  /** The current reading a command menu shows beside an entry that opens this surface. */
  readonly value?: (target?: CommandSurfaceTarget) => string | undefined
  /** Whether a command menu lists an entry that opens this surface now. Absent means always. */
  readonly listed?: () => boolean
}

/** The web client's place for every kernel surface. Total by type, so a new
 *  protocol surface does not compile until this client maps it. `undefined`
 *  states that this host has no such place, so no list offers the entry. */
type KernelSurfaceTable = { readonly [Surface in KernelSurface]: WebSurface | undefined }

/** The sheet of each place inside Settings that a command opens at. */
const SETTINGS_PLACES = { authentication: "providers" } as const satisfies { readonly [Place in SurfacePlace]: ClientSheetId }

function kernelSurfaces(client: ClientContextValue): KernelSurfaceTable {
  const sheet = (id: ClientSheetId): WebSurface => ({ open: () => client.openSheet(id) })
  const running = () => client.state().processStatus?.activeBackgroundCommands.length ?? 0
  return {
    // The work of the chat in front, listed only while some of it runs, as
    // the terminal's prompt bar counts it.
    background: { open: () => client.openSheet("background"), listed: () => running() > 0, value: () => `${running()} running` },
    models: {
      open: (opening) => client.openSheet(opening?.target?.kind === "transcript-in-view" ? "model" : "models"),
      value: (target) => (target?.kind === "transcript-in-view" ? client.state().settings?.seatModel : undefined),
    },
    settings: { open: (opening) => client.openSheet(opening?.target?.kind === "place" ? SETTINGS_PLACES[opening.target.place] : "settings") },
    // The argument names a profile to switch to, as in the terminal.
    "auth-profiles": { open: (opening) => client.openSheet("profiles", opening?.argument === undefined || opening.argument.trim() === "" ? undefined : { kind: "switch-profile", name: opening.argument }) },
    status: { open: () => client.openSheet("status"), value: () => describeUpdateStatus(client.state().update?.status) },
    // A phone has no keyboard to take the chords, so its host offers none.
    "keyboard-shortcuts": client.host.capabilities.keyboardShortcuts === true ? sheet("shortcuts") : undefined,
    commands: sheet("commands"),
    "new-chat": { open: () => client.actions.newSession() },
    sessions: { open: () => client.openSheet("sessions"), value: () => `${client.state().sessions.length}` },
    changes: { open: () => client.openSheet("changes"), value: () => changesLabel(client.state().changes?.summary) },
    resume: { open: () => client.actions.resume() },
    "attach-files": { open: () => client.pickFiles() },
    find: { open: (opening) => client.openFind(opening?.argument) },
    // Close chat acts on the chat in front only, so a pane with no session
    // lists none, and an agent's view refuses it as a chat-only command.
    "close-chat": {
      open: () => {
        const state = client.state()
        const kind = summaryOf(state, state.sessionId)?.kind
        if (kind === "subagent" || kind === "workflow-agent") client.report("warning", chatOnlyCommandNotice("close", kind))
        else if (state.sessionId === undefined) client.report("warning", "No active chat session")
        else client.actions.closeSession(state.sessionId)
      },
      listed: () => client.state().sessionId !== undefined,
    },
  }
}

/** The reading a command menu shows beside a command's entry. */
interface CommandReading {
  readonly text: string
  /** True while the reading waits on the runtime. */
  readonly busy?: boolean
}

/** This client's reading for each reading a command descriptor can name
 *  (ARCH-PROTOCOL-037: keyed by reading, never by command id). */
const COMMAND_READINGS = {
  // The runway left before auto-compaction, as the context gauge reads it.
  "context-window": (client) => {
    const budget = client.state().budget
    if (budget === undefined) return undefined
    if (budget.totalsLoading) return { text: "totals loading", busy: true }
    const reading = compactionReading(budget.contextPromptTokens, compactionTrigger(budget))
    return { text: reading === null ? `${Math.round(budget.contextPercent)}% of window used` : `${reading.remainingPercent}% left` }
  },
} satisfies { readonly [K in CommandReadingKind]: (client: ClientContextValue) => CommandReading | undefined }

/** The current reading beside the entry of `command`, if it has one. */
export function commandReading(client: ClientContextValue, command: BuiltInCommandDescriptor): CommandReading | undefined {
  if (command.opens === undefined) return command.reading === undefined ? undefined : COMMAND_READINGS[command.reading](client)
  const text = client.surface(command.opens)?.value?.(command.target)
  return text === undefined ? undefined : { text }
}

/** The published commands in command-menu order, without a command whose
 *  surface this host has no place for. The command menu and the Commands
 *  sheet both list these. */
export function offeredCommandGroups(client: ClientContextValue) {
  const offered = (command: BuiltInCommandDescriptor) => command.opens === undefined || client.surface(command.opens) !== undefined
  const { top, chat, more, rest } = commandMenuGroups(client.state().builtInCommands)
  return { top: top.filter(offered), chat: chat.filter(offered), more: more.filter(offered), rest: rest.filter(offered) }
}

/** Why the command `name`, which the catalog lists, does not run in the view
 *  in front, if it does not, for a typed token and a command menu row alike
 *  (PI-INTERACTION-081). A surface this host has no place for is no command
 *  here. In an agent's view, a command opens its surface for that agent, and
 *  one that acts on a chat is refused under the command's own token, as the
 *  terminal names it. */
export function commandRefusal(client: ClientContextValue, name: string): string | undefined {
  const state = client.state()
  const builtIn = state.builtInCommands.find((candidate) => candidate.id === name || candidate.aliases.includes(name))
  if (builtIn?.opens !== undefined) return client.surface(builtIn.opens) === undefined ? UNKNOWN_COMMAND_NOTICE : undefined
  const agent = summaryOf(state, state.sessionId)?.kind
  if (agent !== "subagent" && agent !== "workflow-agent") return undefined
  return chatOnlyCommandNotice(builtIn?.id ?? name, agent)
}

/** Resolves a surface id to this client's place for it: a kernel surface,
 *  a surface a registered module opens (`modules`), or one of the client's
 *  own sheets by its id. Undefined when this client has no such place. */
export function createWebSurfaces(client: () => ClientContextValue, modules: ReadonlyMap<string, () => void>): (id: string) => WebSurface | undefined {
  let kernel: KernelSurfaceTable | undefined
  const isKernel = (table: KernelSurfaceTable, id: string): id is KernelSurface => Object.hasOwn(table, id)
  return (id) => {
    kernel ??= kernelSurfaces(client())
    if (isKernel(kernel, id)) return kernel[id]
    const module = modules.get(id)
    if (module !== undefined) return { open: module }
    return isClientSheetId(id) ? { open: () => client().openSheet(id) } : undefined
  }
}
