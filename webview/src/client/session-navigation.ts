import type { TranscriptStore } from "../../../src/protocol/client/transcript-store.js"
import { describeFailure } from "./failure-message.js"
import type { HoldOutcome } from "../../../src/protocol/client/held-session-details.js"

/** The name a new chat has until its catalog row names it. */
const NEW_CHAT_LABEL = "New chat"

/** How a notice ends when the pane had no other chat to open, so it shows
 *  the new chat. Nothing is created until the person sends a message. */
const NO_OTHER_CHAT = "and this project has no other chat"

/** What a tap knows about its destination before the session's own row can
 *  say: the words the person tapped, and the session the link sat in. */
export interface SessionLink {
  /** The name of what the person tapped, until the session's own row names it. */
  readonly label?: string | undefined
  /** The session the person opened this one from, until its own row names its parent. */
  readonly parentSessionId?: string | undefined
}

/** What the pane says about a move the person did not make. */
interface PaneNotice {
  readonly title: string
  readonly message: string
}

/** One move of the pane: what the tap knew, and whether the destination is
 *  the chat the runtime just created for the new chat. */
export interface SessionMove extends SessionLink {
  readonly created?: boolean
  /** True for the session that the address the page loaded on names. */
  readonly address?: true
  /** Why the pane moved when the person did not move it. */
  readonly notice?: PaneNotice
}

/** What the pane knows about the place the last move took it, beyond the
 *  selected session id that the session owns. Every move replaces it. */
export interface SessionDestination extends SessionLink {
  /** True for the chat the runtime just created for the new chat: an empty
   *  root chat, so it shows and serves before its catalog row or detail. */
  readonly created?: true
  /** True while the pane waits for the detail of a session that it neither
   *  lists nor created, so it has nothing of that session to show yet. */
  readonly awaitsDetail?: true
  /** True while the pane waits on the session that the page's address
   *  names. An address can be old, so a session the runtime no longer has
   *  opens the default session instead of a pane that names nothing. */
  readonly address?: true
  /** Why the destination could not open, in words. */
  readonly failure?: string
  /** Why the pane moved here when the person did not move it, such as
   *  another client's delete of the session it showed. It shows until the
   *  person dismisses it or moves on. */
  readonly notice?: PaneNotice
}

export interface SessionNavigationDeps {
  /** Opens `next` in the pane now: the selection, its transcript, and its
   *  readers, which read whatever the page does not follow yet. It calls
   *  `moved` for the move. */
  readonly show: (next: string | undefined, open?: SessionMove) => void
  readonly selected: () => string | undefined
  readonly isListed: (sessionId: string) => boolean
  readonly isHeld: (sessionId: string) => boolean
  readonly hold: (sessionId: string) => Promise<HoldOutcome>
  /** Creates a chat in the runtime and answers its id, or rejects with why not. */
  readonly createChat: () => Promise<string>
  readonly refreshCatalog: () => Promise<void>
  /** The shown session's transcript, whose first read can fail. */
  readonly transcript: () => (Pick<TranscriptStore, "status" | "unavailable"> & { readonly view: Pick<TranscriptStore["view"], "blocks"> }) | undefined
  /** The session the pane opens when the session it would show is gone,
   *  other than `gone`, or undefined when there is none. */
  readonly fallback: (gone: string) => string | undefined
  readonly emit: () => void
  readonly disposed: () => boolean
}

/** Where a tap takes the pane, and what the pane shows on the way.
 *
 *  Every move applies in the tap: the selection, the title, and the pane move
 *  first, and the content loads behind them. A destination that cannot show
 *  yet is an opening the pane draws as a loading screen, and an open that
 *  fails says why in that same pane, where the person is looking.
 *
 *  A new chat is one destination however it is reached: the New chat control,
 *  a first message with no chat open, or a slash command with no chat open.
 *  One creation runs at a time, every way in joins it, and it settles into
 *  the pane whenever the pane is on the new chat when the runtime answers. */
export interface SessionNavigation {
  /** The place the last move took the pane. */
  readonly destination: SessionDestination
  /** The destination while the pane cannot show it: a new chat that the
   *  runtime is creating or could not create, a session whose detail is
   *  still being read or could not be read, or a session whose first
   *  transcript read failed. Undefined once it can show. It keeps its
   *  identity while it says the same thing. */
  readonly opening: SessionDestination | undefined
  /** Counts the moves, so a slow answer can tell that the person moved on. */
  readonly version: number
  /** Records a move to `next`. Every way a session opens passes here. */
  moved(next: string | undefined, open?: SessionMove): void
  /** Settles the opening of `next` with its hold, unless the person moved on
   *  after `version`. */
  settle(next: string, version: number, outcome: HoldOutcome): void
  select(next: string, link?: SessionLink): Promise<void>
  /** Moves the pane off `gone`, a deleted session: to `parentSessionId`
   *  while this page still has it, else to the fallback session, else to the
   *  new chat when the project has no other chat. A delete the
   *  person did not make here is `noticed`: the pane then says why it moved. */
  leave(gone: string, parentSessionId: string | undefined, noticed: boolean): void
  /** Clears the destination's notice. */
  dismissNotice(): void
  /** Moves the pane to the new chat now, and starts its creation or joins
   *  the one that runs. Answers the created chat's id, or rejects with why
   *  the runtime could not create it. */
  newChat(): Promise<string>
  /** `newChat` for a control: it rejects only when the person has left the
   *  new chat, because otherwise its pane already says why it failed. */
  openNew(): Promise<void>
}

export function createSessionNavigation(deps: SessionNavigationDeps): SessionNavigation {
  let destination: SessionDestination = {}
  let version = 0
  /** The one creation that runs: the created chat's id, and the answer a
   *  control gets, which is the same for every tap that joins it. */
  let creation: { readonly created: Promise<string>; readonly opened: Promise<void> } | undefined

  /** The opening that says why the shown session's first transcript read
   *  failed, kept for as long as the destination and the failure hold. */
  let unread: { readonly destination: SessionDestination; readonly cause: TranscriptStore["unavailable"]; readonly opening: SessionDestination } | undefined

  /** The shown destination with why its transcript cannot show, or
   *  undefined. Only a read that left nothing on screen is a failed
   *  destination: a window already shown stays, and the next attach reads
   *  again. */
  function unreadable(): SessionDestination | undefined {
    const transcript = deps.transcript()
    if (transcript?.status !== "recovery-failed" || transcript.view.blocks.length > 0 || transcript.unavailable === undefined) return undefined
    const cause = transcript.unavailable
    if (unread?.destination !== destination || unread.cause !== cause) {
      unread = { destination, cause, opening: { ...destination, failure: `Flywheel could not read this session's transcript: ${describeFailure(cause.diagnostic)}` } }
    }
    return unread.opening
  }

  function opening(): SessionDestination | undefined {
    const selected = deps.selected()
    if (selected === undefined) return creation !== undefined || destination.failure !== undefined ? destination : undefined
    // A destination whose detail has arrived is open, whatever answered
    // it: the first read, a retry, or the refresh after a reconnect.
    const waiting = destination.awaitsDetail === true && !deps.isHeld(selected) ? destination : undefined
    return waiting?.failure === undefined ? unreadable() ?? waiting : waiting
  }

  /** True while the pane shows the new chat rather than a session. */
  const onNewChat = (): boolean => !deps.disposed() && deps.selected() === undefined

  async function create(): Promise<string> {
    let sessionId: string
    try {
      sessionId = await deps.createChat()
    } catch (cause) {
      creation = undefined
      if (onNewChat()) {
        destination = { label: NEW_CHAT_LABEL, failure: `Flywheel could not start a new chat: ${describeFailure(cause)}` }
        deps.emit()
      }
      throw cause
    }
    creation = undefined
    // A person who left the new chat finds it in the list; the pane stays
    // where they went.
    if (onNewChat()) deps.show(sessionId, { label: NEW_CHAT_LABEL, created: true })
    void deps.refreshCatalog()
    return sessionId
  }

  /** Moves the pane to the new chat and answers the creation it waits on. */
  function start(): NonNullable<typeof creation> {
    let running = creation
    if (running === undefined) {
      const created = create()
      const opened = created.then(() => {}, (cause: unknown) => { if (!onNewChat()) throw cause })
      // A caller that wants only the id leaves this answer unread.
      opened.catch(() => {})
      running = { created, opened }
      creation = running
    }
    deps.show(undefined)
    deps.emit()
    return running
  }

  /** Moves the pane off `gone`, an address the runtime says it does not
   *  have, unless the person moved after `requested`. The session the pane
   *  opens instead is a catalog row, and on a cold load the detail can answer
   *  before the catalog does, so the move waits for the catalog's read and
   *  the pane shows the address opening until then. */
  async function leaveMissingAddress(gone: string, requested: number): Promise<void> {
    await deps.refreshCatalog()
    if (requested !== version || deps.selected() !== gone) return
    const fallback = deps.fallback(gone)
    deps.show(fallback, { notice: { title: "Session not found", message: `Flywheel could not find that session, ${fallback === undefined ? NO_OTHER_CHAT : "so it opened another chat"}.` } })
    deps.emit()
  }

  return {
    get destination() { return destination },
    get opening() { return opening() },
    get version() { return version },
    moved(next, open = {}) {
      version += 1
      const link: SessionLink = {
        ...(open.label === undefined ? {} : { label: open.label }),
        ...(open.parentSessionId === undefined ? {} : { parentSessionId: open.parentSessionId }),
      }
      const noticed = open.notice === undefined ? {} : { notice: open.notice }
      if (next === undefined) destination = { ...(creation === undefined ? {} : { label: NEW_CHAT_LABEL }), ...noticed }
      else if (open.created === true) destination = { ...link, created: true }
      else if (deps.isListed(next) || deps.isHeld(next)) destination = { ...link, ...noticed }
      else destination = { ...link, ...noticed, awaitsDetail: true, ...(open.address === true ? { address: true } : {}) }
    },
    settle(next, requested, outcome) {
      // A destination whose detail a newer read already delivered is open,
      // whatever this hold came to.
      if (requested !== version || deps.selected() !== next || destination.awaitsDetail !== true || outcome.kind === "held" || deps.isHeld(next)) return
      // Only the runtime's own answer that the session is gone moves the
      // pane off an address; a read that failed says so and can try again.
      if (destination.address === true && outcome.kind === "missing") {
        void leaveMissingAddress(next, requested)
        return
      }
      destination = { ...destination, failure: holdFailure(outcome) }
      deps.emit()
    },
    async select(next, link) {
      if (deps.disposed()) return
      if (next === deps.selected() && opening()?.failure === undefined) return
      deps.show(next, link)
      const requested = version
      // The hold joins the read the open started, so this waits on it without
      // reading twice.
      await deps.hold(next)
      if (requested === version) deps.emit()
    },
    leave(gone, parentSessionId, noticed) {
      const toParent = parentSessionId !== undefined && (deps.isListed(parentSessionId) || deps.isHeld(parentSessionId))
      const next = toParent ? parentSessionId : deps.fallback(gone)
      const message = `The session you had open was deleted, ${toParent ? "so Flywheel opened its parent" : next === undefined ? NO_OTHER_CHAT : "so Flywheel opened another chat"}.`
      deps.show(next, noticed ? { notice: { title: "Session deleted", message } } : {})
      deps.emit()
    },
    dismissNotice() {
      const { notice: _dismissed, ...rest } = destination
      destination = rest
      deps.emit()
    },
    newChat: () => start().created,
    openNew: () => start().opened,
  }
}

/** The words a destination shows when its session could not be opened. */
function holdFailure(outcome: Exclude<HoldOutcome, { readonly kind: "held" }>): string {
  switch (outcome.kind) {
    case "missing": return "Flywheel could not find this session."
    case "failed": return `Flywheel could not open this session: ${describeFailure(outcome.cause)}`
    case "released": return "Flywheel stopped reading this session. Try again."
  }
}
