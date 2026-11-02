import { createContext, useContext, type Accessor } from "solid-js"

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { SessionChangesController } from "../../../src/protocol/client/session-changes.js"
import type { ClientActions } from "../client/actions.js"
import type { ReadingPlace } from "../client/reading-place.js"
import type { RuntimeSession } from "../client/session.js"
import type { ClientViewState } from "../client/view-state.js"
import type { ClientSheetId, SheetFocus } from "../../../src/protocol/client/host-contract.js"
import type { ClientHost } from "../host.js"
import type { ScreenStack } from "./screen-stack.js"
import type { WebSurface } from "./surfaces.js"
import type { SurfaceOpening } from "../../../src/protocol/client/surface-presentation.js"

/** A yes-or-no question the client asks before something irreversible. */
export interface ConfirmRequest {
  readonly title: string
  readonly detail?: string
  /** The verb on the confirming button, which names the consequence. */
  readonly confirmLabel: string
  /** Names the consequence of declining. Omitted for the usual Cancel action. */
  readonly cancelLabel?: string
  readonly destructive?: boolean
  /** Focus Cancel instead of the confirming action when the dialog opens. */
  readonly cancelByDefault?: boolean
}

/** Text the client needs before it can act, with an optional second labeled field. */
export interface PromptRequest {
  readonly title: string
  readonly detail?: string
  readonly placeholder?: string
  readonly initialValue?: string
  readonly label?: string
  /** An extra independently edited line. Changes are local until the prompt settles. */
  readonly secondaryField?: {
    readonly label: string
    readonly initialValue: string
    readonly maxLength?: number
    readonly onChange: (value: string) => void
    readonly validate?: () => string | undefined
  }
  readonly confirmLabel: string
  /** Returns a message when the value is not acceptable, so the dialog can say
   *  what is wrong instead of refusing silently. */
  readonly validate?: (value: string) => string | undefined
}


/** What every component can reach.
 *
 *  One object, provided once at the root, so a component deep in the tree
 *  neither threads twelve props nor imports a global. The state accessor is the
 *  only reactive member; everything else is stable for the life of the mount. */
export interface ClientContextValue {
  /** Aborts pending client actions when this app mount is released. */
  readonly signal: AbortSignal
  readonly changes: Accessor<SessionChangesController | undefined>
  readonly host: ClientHost
  readonly connection: RuntimeConnection
  readonly actions: ClientActions
  readonly state: Accessor<ClientViewState>
  /** Holds submission while the runtime or provider cannot accept the draft. */
  readonly submissionHeld?: Accessor<boolean>
  /** Puts a message in front of the person. It disappears on its own. */
  readonly report: (severity: "info" | "warning", message: string) => void
  readonly openSheet: (sheet: ClientSheetId, focus?: SheetFocus) => void
  readonly closeSheet: () => void
  /** Lets an account login question whose answer never reached the runtime be asked again. */
  readonly retryLoginQuestion: (questionId: string) => void
  /** The focus the open sheet was asked for, consumed by that sheet. */
  readonly sheetFocus: Accessor<SheetFocus | undefined>
  /** An optional signal withdraws a dialog when its owning surface closes. */
  readonly confirm: (request: ConfirmRequest, signal?: AbortSignal) => Promise<boolean>
  readonly prompt: (request: PromptRequest, signal?: AbortSignal) => Promise<string | undefined>
  readonly focusComposer: () => void
  readonly insertText: (text: string) => void
  /** Moves the message `entryId` names, or the newest one that did not go
   *  through, from the transcript into the composer for editing. */
  readonly recallLocal: (entryId?: string) => void
  /** Opens the find bar over the transcript. */
  /** Opens Find in transcripts, searching for `query` when one is given. */
  readonly openFind: (query?: string) => void
  /** Starts a file mention in the composer, which opens the file picker. */
  readonly openMentions: () => void
  /** Opens the device's file chooser; what it picks attaches to the next message. */
  readonly pickFiles: () => void
  /** Opens the client surface a command names, at `target` inside it.
   *  Nothing happens when this client has no surface by that id. */
  readonly openSurface: (surface: string, opening?: SurfaceOpening) => void
  /** This client's place for the surface `id`, or undefined when it has none. */
  readonly surface: (id: string) => WebSurface | undefined
  /** The block the transcript should light and scroll to, once. */
  readonly markedBlock: Accessor<string | undefined>
  readonly markBlock: (blockId: string | undefined) => void
  /** The reader's place across a reload onto a new client build, which the
   *  transcript restores once and keeps readable for the next reload. */
  readonly readingPlace: ReadingPlace
  /** What the surfaces leave in each session the page keeps resident, such
   *  as the reader's place and the unsent message, for the person's return,
   *  and where the last move took the pane. */
  readonly residents: Pick<RuntimeSession, "memory" | "onLeave" | "destination">
  /** The shared detail owner follows admission for child cards. */
  readonly sessionDetails?: {
    get: RuntimeSession["sessionDetail"]
    subscribe: RuntimeSession["subscribeSessionDetail"]
  }
  /** A question tap is an action, not a change to ordinary reading-place policy. */
  readonly attention?: Accessor<{ readonly sessionId: string; readonly sequence: number } | undefined>
  /** The phone's screen stack. Present only under a host that reaches
   *  runtimes through a relay: there the client is the whole screen and owns
   *  the way between the list and a chat. Absent in the editor. */
  readonly stack?: ScreenStack | undefined
}

export const ClientContext = createContext<ClientContextValue>()

export function useClient(): ClientContextValue {
  const value = useContext(ClientContext)
  if (value === undefined) throw new Error("useClient must be called under the client root")
  return value
}
