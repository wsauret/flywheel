import type { RuntimePosition } from "./runtime-ui-protocol-types.js"

type BuiltInCommandId = string

/** The client surfaces the kernel's own commands open. Each client maps
 *  every one to its own place, or states that it has none; a module's
 *  surfaces are named in that module's protocol home. A surface receives the
 *  command's argument text.
 *
 *  - `background`: Background work of the chat in front.
 *  - `models`: Models, the screen of every role's model and effort; with
 *    target `transcript-in-view`, the model and effort of that one session.
 *  - `settings`: Settings, at the place a `place` target names.
 *  - `auth-profiles`: Auth profiles; the argument names a profile to switch to.
 *  - `status`: Status.
 *  - `keyboard-shortcuts`: Keyboard shortcuts.
 *  - `commands`: the full command list.
 *  - `new-chat`: a new chat, brought to the front.
 *  - `sessions`: Sessions.
 *  - `changes`: Changes of the chat in front and the agents it launched.
 *  - `resume`: the chat in front, continued from where it stopped.
 *  - `attach-files`: this computer's file chooser, which attaches to the prompt.
 *  - `find`: Find in transcripts; the argument is the query. */
export type KernelSurface =
  | "background" | "models" | "settings" | "auth-profiles" | "status" | "keyboard-shortcuts" | "commands"
  | "new-chat" | "sessions" | "changes" | "resume" | "attach-files" | "find"

/** A place inside a surface that a command opens at. */
export type SurfacePlace = "authentication"

/** Where inside its surface a command lands. `place` is a nested target: the
 *  named place inside the surface, which a client without that place maps to
 *  its own home for it. `transcript-in-view` is a contextual target: the
 *  session whose transcript the person sees when the command runs, whether a
 *  chat, a subagent, or a workflow agent, and never the parent chat of an
 *  agent in view (PI-INTERACTION-019). */
export type CommandSurfaceTarget =
  | { readonly kind: "place"; readonly place: SurfacePlace }
  | { readonly kind: "transcript-in-view" }

/** Where a command sits in a command menu (ARCH-PROTOCOL-037). `top` is the
 *  list a client opens first, `chat` the actions on the chat in front, and
 *  `more` the other entries a bare command menu still lists; each lists
 *  ascending `rank`. Ranks are gapped so an owner can place a new command
 *  between two others. A command without a position follows them in
 *  publication order, and a command menu offers it only to typing
 *  (PI-INTERACTION-017). Each owner sets the position of its own commands. */
export interface CommandMenuPosition {
  readonly group: "top" | "chat" | "more"
  readonly rank: number
}

/** A reading a client shows beside the entry of a command that opens no
 *  surface. `context-window`: the runway left before auto-compaction. A
 *  command that opens a surface reads through that surface instead. */
export type CommandReading = "context-window"

/** Metadata for one kernel or capability-contributed built-in command that
 *  the runtime runs now. `title` is the command's one name, which is also the
 *  heading of the surface it opens (PI-INTERACTION-081). */
export interface BuiltInCommandDescriptor {
  readonly id: BuiltInCommandId
  readonly title: string
  readonly description: string
  readonly aliases: readonly string[]
  /** The client surface that is the command's whole effect: a
   *  `KernelSurface` or a surface a module names. A client opens it without
   *  asking the runtime, so the surface opens, and holds the actions that
   *  need the runtime, also while the runtime does not answer. Absent for a
   *  command the runtime executes. */
  readonly opens?: string
  /** Where inside `opens` the command lands. */
  readonly target?: CommandSurfaceTarget
  readonly menu?: CommandMenuPosition
  readonly reading?: CommandReading
}

/** A built-in command that only a module turned off for this project can
 *  provide. No list, palette, or completion offers it (PI-CAP-001). A client
 *  holds it only so that a person who types it exactly hears which module is
 *  off and how to turn it on. */
export interface OffCommandDescriptor {
  readonly id: BuiltInCommandId
  readonly aliases: readonly string[]
  /** The Settings names of the modules that provide the command. Any one of
   *  them turned on makes it available. */
  readonly modules: readonly string[]
}

/** The published roster of the built-in commands a person can run. Skills
 *  are agent methods and never appear here (ARCH-PROTOCOL-038). `revision`
 *  counts publications: each republication builds a new roster under a new
 *  revision, so a client echoes the revision it rendered and the runtime
 *  refuses an invocation from an older one. */
export interface RuntimeCommandCatalog {
  readonly revision: number
  readonly builtInCommands: readonly BuiltInCommandDescriptor[]
  readonly offCommands: readonly OffCommandDescriptor[]
}

export interface RuntimeCommandCatalogResult extends RuntimeCommandCatalog {
  readonly snapshotPosition: RuntimePosition
}

export type CommandCatalogPatchPayload = { readonly kind: "commands.updated"; readonly catalog: RuntimeCommandCatalog }

/** Explicit user invocation of one built-in command. The client sends the
 *  catalog descriptor id it rendered and the catalog revision it rendered it
 *  from; the runtime executes the command's handler in the composition that
 *  published the descriptor and answers one closed outcome. */
export interface RuntimeCommandInvocation {
  readonly type: "command.invoke"
  /** Catalog descriptor id, never an alias. Clients resolve aliases before dispatch. */
  readonly id: string
  /** The catalog revision the client rendered. A mismatch answers `stale`. */
  readonly revision: number
  /** The chat session the command acts in, when the client has one in front. */
  readonly sessionId?: string
  /** The user's raw argument text, verbatim. */
  readonly argument?: string
}

/** Everything a built-in command can answer. A client presents each variant
 *  with its own affordance and never interprets a command id. */
export type CommandOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "warning"; readonly message: string }
  /** Open the named client surface. An optional sessionId binds presentation to the source session's unchanged placement. */
  | { readonly kind: "open"; readonly surface: string; readonly sessionId?: string }
  /** Bring this session to the front; a command that created it answers this. */
  | { readonly kind: "focus-session"; readonly sessionId: string }
  /** The invocation echoed a catalog revision the runtime no longer publishes. */
  | { readonly kind: "stale" }
  /** No enabled command publishes this id, or the named session cannot host it. */
  | { readonly kind: "unavailable"; readonly message: string }

export function commandCatalogCursor() {
  return { scope: "workspace", domain: "commands" } as const
}
