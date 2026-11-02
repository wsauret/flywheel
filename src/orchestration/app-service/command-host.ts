import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, InFlightRecord } from "../../infra/event-store-types.js"
import type { ModuleRuntimeHandle } from "../../infra/module-runtime.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import type { CommandOutcome } from "../../protocol/command-catalog-protocol-types.js"
import type { SessionFactWriter } from "../session/session-fact-writer.js"

/** What a built-in command handler may reach while it executes in the runtime
 *  (ARCH-STRUCTURE-017). Every member is a kernel primitive: the host names no module, so
 *  adding a command adds a contribution and no host member. */
export interface CommandHost {
  /** The resolved chat session the command acts in, or undefined when the invocation named none. */
  readonly session: CommandSession | undefined
  readonly directories: ProjectDirectories
  /** The directory of the auth profile that new sessions use, which holds its provider logins. */
  readonly authDirectory: () => string
  readonly projectionReader: AsyncEventStateReadSurface
  /** Absent in a composition that owns no launcher; a command that needs a process refuses. */
  readonly runOwnedCommand: OwnedCommandRunner | undefined
}

/** The prompt a command delivers into its session as the next turn. `context`
 *  is request-only: the model reads it once and the transcript shows `label`. */
export interface CommandPrompt {
  readonly text: string
  readonly label: string
  readonly args?: string
  readonly context: string
}

/** A turn that starts an installed skill's method (PI-AGENT-038). The person
 *  runs the command, never the skill, so the transcript shows `label`. */
export interface CommandMethod {
  readonly skill: string
  /** The command the person typed, such as `/experiment design`. */
  readonly label: string
  /** The command's argument text, which the method reads as its ARGUMENTS. */
  readonly args?: string
}

export interface CommandSession {
  readonly id: string
  readonly executionCwd: string
  /** Delivers a prompt into the session as its next turn. False when the session cannot take a turn. */
  prompt(input: CommandPrompt): Promise<boolean>
  /** Commits the skill's method, rendered as the model's `skill` tool loads it,
   *  as the session's next turn. Answers `none` when the turn is delivered, and
   *  a warning that names the skill, with no turn, when the skill is not
   *  installed or the module selection does not make it available. */
  startMethod(input: CommandMethod): Promise<CommandOutcome>
  /** Appends one system line to the transcript without starting a turn. */
  systemLine(message: string, level?: "info" | "error"): Promise<void>
  /** Runs the durable-learning review of this conversation. False when current policy refuses it. */
  review(): Promise<boolean>
  interrupt(): void
  /** Compacts the conversation's context. False when there is no context to compact yet. */
  compact(): Promise<boolean>
  /** Forks the committed conversation into a new session and answers its id. */
  fork(): Promise<string>
  /** The live runner's per-runner module runtime for this session, when the session is live. */
  runtime<T>(handle: ModuleRuntimeHandle<T>): T | undefined
  /** Attaches the chat if needed and lends a session-scoped module host.
   * Never starts or waits for a model turn; unavailable sessions return undefined. */
  host<T>(handle: ModuleRuntimeHandle<T>): Promise<T | undefined>
  /** Strict fact writer bound to this session, disposed when the invocation settles. */
  facts(): SessionFactWriter
  /** In-flight reads for this session. */
  readInFlight(kinds: readonly string[]): Promise<InFlightRecord[]>
}
