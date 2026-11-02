import { withDeadline } from "../../infra/with-deadline.js"
import { runtimeCallPolicies } from "../runtime-client-deadlines.js"

/** A client's hold on the runtime's command catalog, which arrives a moment
 *  after the client connects. */
export interface CommandCatalogReadiness {
  /** Whether the client holds a catalog the runtime published. */
  known(): boolean
  /** Settles when the client receives its first catalog. */
  readonly arrived: Promise<void>
}

/** The longest a slash command waits for the catalog: the deadline of the
 *  catalog read. Past it, that read has failed, so a longer wait cannot help. */
export const COMMAND_CATALOG_WAIT_MS = runtimeCallPolicies.commandCatalog.deadlineMs

const CATALOG_LOADING_NOTICE = "Commands are still loading; your command stays in the prompt"

/** What every client says when a typed slash token names no command; the
 *  client keeps the text and never sends it as a message (PI-INTERACTION-081). */
export const UNKNOWN_COMMAND_NOTICE = "Unknown command. Try /help"

/** The kind of agent whose transcript is in view. */
export type AgentViewKind = "subagent" | "workflow-agent"

/** What every client says when a command that acts on a chat, such as one the
 *  runtime runs or a skill, is typed in an agent's view. It is refused before
 *  dispatch and never sent to the agent as a message (PI-INTERACTION-081). A
 *  command that opens a surface opens it there, for the transcript in view. */
export function chatOnlyCommandNotice(token: string, view: AgentViewKind): string {
  return `/${token} works in a chat, not in this ${view === "subagent" ? "subagent" : "workflow agent"}`
}

/** A slash command's route once the client can decide it: the route that owns
 *  the token; no owner in a known catalog; or a catalog that did not arrive in
 *  time, in which case the client keeps the command in its prompt and shows
 *  `notice`. */
export type SettledSlashRoute<R> =
  | { readonly kind: "routed"; readonly route: R }
  | { readonly kind: "unowned" }
  | { readonly kind: "loading"; readonly notice: string }

/** A settled route, or the wait for the catalog that decides it. */
export type SlashRoute<R> = SettledSlashRoute<R> | { readonly kind: "waiting"; readonly settled: Promise<SettledSlashRoute<R>> }

/** The one rule every client uses to route a typed slash command. `route`
 *  answers the owner of the token from what the client holds now: its own
 *  commands and the catalog, or undefined when nothing owns it. A token that
 *  something owns, or that a known catalog does not own, is decided at once.
 *  Before the first catalog arrives, a token that nothing owns is not yet
 *  unknown: the route waits for the catalog, at most `waitMs`, and asks
 *  `route` again. A client never calls such a token unknown, and never sends
 *  it as text, before the catalog is known. */
export function routeSlashToken<R>(
  catalog: CommandCatalogReadiness,
  route: () => R | undefined,
  waitMs: number = COMMAND_CATALOG_WAIT_MS,
): SlashRoute<R> {
  const decide = (): SettledSlashRoute<R> => {
    const owner = route()
    if (owner !== undefined) return { kind: "routed", route: owner }
    return catalog.known() ? { kind: "unowned" } : { kind: "loading", notice: CATALOG_LOADING_NOTICE }
  }
  const now = decide()
  if (now.kind !== "loading") return now
  return { kind: "waiting", settled: withDeadline(catalog.arrived, waitMs).then(decide, decide) }
}
