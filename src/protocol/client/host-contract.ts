import type { FrontendActivity, RuntimeHealth } from "../app-service-types.js"
import type { BudgetView } from "../budget-protocol-types.js"
import type { ModuleId } from "../module-ids.js"
import type { ChangesSummaryState } from "./session-changes.js"
import type { ProviderSummary } from "./provider-summary.js"
import type { RuntimeAuthLoginQuestion } from "../auth-status-protocol-types.js"

/** What crosses between the web client and the host that mounts it.
 *
 *  The client is one bundle that the editor, the local browser page, and the
 *  phone each mount. Since the client ships with the runtime's build and a host
 *  can be older or newer than it, every shape a host reads from the client or
 *  hands to it lives here, in the published client contract, and nowhere in
 *  the client's own tree. */

/** The version of everything a host hands the client at mount and answers
 *  afterwards: `HostCapabilities`, the editor's postMessage vocabulary, and the
 *  page attributes. The client is loaded from the runtime, so a host built
 *  from an older tree can mount a client built for a newer contract; a host
 *  page states the version it was built for, and a client that needs a newer
 *  one shows a plain notice instead of mounting. Raise it when a shape
 *  changes or a capability the client relies on is added; a capability the
 *  client can live without is not a new version, because capabilities
 *  degrade by absence. */
export const HOST_CONTRACT_VERSION = 2
/** Version 1 can mount the client, but cannot commit a lossless replacement. */
export const MINIMUM_HOST_CONTRACT_VERSION = 1

/** What a turn has cost so far, as the panel shows it. */
export type BudgetSummary =
  | { readonly totalsLoading: true; readonly compactionThreshold: number }
  | Omit<Extract<BudgetView, { readonly totalsLoading: false }>, "tokens"> & {
    /** Every token the session has spent, across all turns. */
    readonly totalTokens: number
    /** The proactive-compaction token cap from runtime config; 0 means off. */
    readonly compactionThreshold: number
  }

/** What the client publishes for a host to paint outside the client's own
 *  surface: a status bar, a window title, a badge. It is a projection of state
 *  the client owns, never something the host reconciles on its own. */
export interface ClientSummary {
  /** Whether the runtime answers; a host marks a fault, never a recovery. */
  readonly health: RuntimeHealth
  /** Whether the session catalog has arrived: before it, `sessionId` says
   *  nothing about the project. */
  readonly ready: boolean
  readonly sessionId: string | undefined
  /** The chat at the top of the selected session's parent chain, or
   *  undefined while a link of the chain is unknown. A host that starts work
   *  for the selection names this chat as its origin, never a child. A client
   *  older than this field leaves it out, and the host then names no origin. */
  readonly rootSessionId: string | undefined
  readonly sessionTitle: string | undefined
  readonly executionCwd: string | undefined
  readonly activity: FrontendActivity | undefined
  readonly busy: boolean
  readonly budget: BudgetSummary | undefined
  readonly hasUsableProvider: boolean
  readonly providers: readonly ProviderSummary[]
  readonly changes: ChangesSummaryState | undefined
  /** The modules this project has on, once the runtime names them. A host
   *  shows a command that a module owns only while that module is on. A
   *  client older than this field leaves it out, and the host then shows
   *  every command. */
  readonly moduleIds?: readonly ModuleId[]
}

/** Navigation only: the review opens on `path` when the session changed it.
 *  Undo is authorized by the runtime's own proof, never by a path. */
export interface ChangesReviewTarget {
  readonly sessionId: string
  readonly path?: string
}

/** What a host may ask the client to do. These are the actions a host surfaces
 *  natively, such as a command palette entry or a keybinding, and they act on
 *  the client's selection, which only the client knows. */
export type ClientCommand =
  | { readonly type: "focusComposer" }
  | { readonly type: "insertText"; readonly text: string }
  | { readonly type: "openCommands" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "newSession" }
  | { readonly type: "selectSession"; readonly sessionId: string }
  /** Opens a question at the newest output, overriding the saved reading place. */
  | { readonly type: "attendQuestion"; readonly sessionId: string }
  | { readonly type: "compact" }
  | { readonly type: "interrupt" }
  | { readonly type: "interruptWorkflow" }
  /** Runs one built-in command by its catalog id, in the open session. */
  | { readonly type: "invokeCommand"; readonly id: string }
  /** Drops the lane and attaches again. Only a person asks for this. */
  | { readonly type: "reconnect" }
  /** Makes sure the client is attached to its runtime. A working lane stays
   *  open and nothing is read again. A lane that is down or waiting out a
   *  backoff attaches at once. The phone shell sends this when the person
   *  chooses the placement already on screen. */
  | { readonly type: "ensureConnected" }
  /** Opens one of the client's own sheets, so a host's palette entry lands on
   *  the same surface the client offers from its command panel. */
  | { readonly type: "openSheet"; readonly sheet: ClientSheetId; readonly focus?: SheetFocus }
  /** Opens a registered module surface locally, including before connection. */
  | { readonly type: "openSurface"; readonly surface: string }

/** One-way intent delivered to an open sheet. Only connect and reconnect intents start authentication. */
export type SheetFocus =
  | { readonly kind: "reconnect-account"; readonly question: RuntimeAuthLoginQuestion }
  | { readonly kind: "focus-provider"; readonly providerId: string }
  | { readonly kind: "connect-provider"; readonly providerId: string }
  | { readonly kind: "review-paid-use"; readonly providerId: string; readonly accountCorrelationId: string; readonly envelopeId: string }
  /** Switch to the auth profile with this display name, as `/profile <name>` does. */
  | { readonly kind: "switch-profile"; readonly name: string }

/** The sheets the client carries itself. A host may open any of them by name.
 *  Provider sign-in and paid-use review, auth profiles, the role browser, the
 *  provider model catalog, usage, and the session's changes are sheets here and
 *  nowhere else, so the phone and the editor offer the same surfaces
 *  (PI-REMOTE-005). */
const CLIENT_SHEET_IDS = ["sessions", "status", "capabilities", "model", "providers", "profiles", "models", "provider-models", "settings", "background", "changes", "commands", "shortcuts"] as const
export type ClientSheetId = (typeof CLIENT_SHEET_IDS)[number]

export function isClientSheetId(id: string): id is ClientSheetId {
  return CLIENT_SHEET_IDS.some((sheet) => sheet === id)
}

export function openSheetCommand(sheet: ClientSheetId, focus?: SheetFocus): Extract<ClientCommand, { readonly type: "openSheet" }> {
  return { type: "openSheet", sheet, ...(focus === undefined ? {} : { focus }) }
}
