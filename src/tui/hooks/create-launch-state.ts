import { type Accessor, createEffect, onCleanup } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { LAUNCH_STATE_VERSION, type LaunchState, type LaunchModalRoute } from "../../infra/launch-state.js"
import type { OverlayLayers } from "../components/modal-stack.js"
import type { ComposerHandle } from "../components/composer-types.js"
import { setLaunchStateCapture } from "../exit.js"
import { transcriptPlace, type TranscriptLayoutSlot } from "../output-window/output-window-scroll.js"
import type { DraftCache } from "./create-draft-cache.js"
import type { TabInfo } from "./create-tabs.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { SessionRoute } from "../../protocol/client/held-session-details.js"
import type { ChatSubmissions } from "../../protocol/client/chat-submissions.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"

/** A diff file's disclosure key minted from its position in one process's
 *  rendering; another process mints its own, so the key does not travel. */
const PROVISIONAL_DISCLOSURE = "#diff:id:"
const log = Log.create({ service: "launch-state" })

interface LaunchStateDeps {
  readonly projectRoot: string
  /** The place a predecessor terminal handed this one, if any. */
  readonly handed: LaunchState | undefined
  /** True once the first catalog snapshot is applied, without waiting for totals. */
  readonly catalogReady: Accessor<boolean>
  readonly signals: Pick<ShellSignals, "foregroundId">
  readonly tabs: Accessor<readonly TabInfo[]>
  readonly openSessionTab: (sessionId: string) => void
  readonly draftCache: Pick<DraftCache, "snapshot">
  /** The messages this terminal sent that the runtime has not answered. */
  readonly outbox: Pick<ChatSubmissions, "unsent">
  readonly composer: () => Pick<ComposerHandle, "persistDraft">
  readonly transcripts: Pick<ShellServices["transcripts"], "visibleRange" | "disclosures" | "setDisclosure">
  readonly layout: (sessionId: string) => TranscriptLayoutSlot
  readonly overlay: Pick<OverlayLayers, "route">
  readonly activateSessionById: (sessionId: string) => Promise<void>
  readonly restoreModule: (route: LaunchModalRoute) => Promise<boolean>
  readonly resolveSessionRoute: (sessionId: string) => Promise<SessionRoute | undefined>
  readonly reopen: { readonly sessions: () => void; readonly theme: () => void }
  /** Opens a new or reused empty chat, and answers whether it opened. */
  readonly startChat: () => Promise<boolean>
  /** Lanes that open after a first chat failed, so it opens on the next. */
  readonly lanes: Pick<AttachedRuntimeClient, "onLane">
}

export interface TerminalPlace {
  /** Opens what the terminal shows first: the handed place when there is
   *  one, otherwise a new or reused empty chat. */
  restore(): Promise<void>
}

/** Carries what the person sees across a terminal re-execution (ARCH-DISTRIBUTION-031).
 *  Drafts are seeded by the draft cache itself before mount; this seeds the
 *  expanded rows and each session's scroll place at once, restores tabs, the
 *  foreground, and the open modal on mount, and states the same place again
 *  when this terminal is replaced in turn. */
export function createLaunchState(deps: LaunchStateDeps): TerminalPlace {
  const { handed } = deps
  for (const [sessionId, blocks] of Object.entries(handed?.disclosure ?? {})) {
    for (const [key, expanded] of Object.entries(blocks)) deps.transcripts.setDisclosure(sessionId, key, expanded)
  }
  for (const [sessionId, place] of Object.entries(handed?.scroll ?? {})) {
    if ("blockIndex" in place) deps.layout(sessionId).restoreAnchor = place
  }

  setLaunchStateCapture(capture)
  let disposed = false
  let stopLaneWait: (() => void) | undefined
  onCleanup(() => { disposed = true; stopLaneWait?.(); setLaunchStateCapture(null) })

  /** The terminal opens on a chat. A first chat that fails, such as one whose
   *  runtime did not start in time, opens again when the next lane opens,
   *  unless the person has opened a session by then. Without this the
   *  terminal stays on its load screen with nothing left to wait for. */
  async function openFirstChat(): Promise<void> {
    if (disposed || deps.signals.foregroundId() !== undefined || await deps.startChat() || disposed) return
    await nextLane()
    await openFirstChat()
  }

  /** Resolves when a lane opens after this call, or when the shell closes
   *  first. `onLane` replays the lane already open at once, and a chat that
   *  failed on that lane would fail again on it. */
  function nextLane(): Promise<void> {
    return new Promise((resolve) => {
      let replaying = true
      const release = (): void => {
        stop()
        stopLaneWait = undefined
        resolve()
      }
      const stop = deps.lanes.onLane(() => { if (!replaying) release() })
      replaying = false
      stopLaneWait = release
    })
  }


  function capture(): LaunchState {
    // The live buffer, and its caret, reach the draft cache only on a switch.
    deps.composer().persistDraft()
    const foreground = deps.signals.foregroundId() ?? null
    const tabs = deps.tabs().flatMap((tab) => tab.kind === "session" ? [tab.id] : [])
    const sessions = [...new Set(foreground === null ? tabs : [...tabs, foreground])]
    const drafts = deps.draftCache.snapshot()
    const outbox = deps.outbox.unsent()
    return {
      version: LAUNCH_STATE_VERSION,
      projectRoot: deps.projectRoot,
      foreground,
      tabs,
      scroll: Object.fromEntries(sessions.flatMap((sessionId) => {
        const place = transcriptPlace(deps.layout(sessionId), deps.transcripts.visibleRange(sessionId))
        return place === undefined ? [] : [[sessionId, place]]
      })),
      disclosure: Object.fromEntries(sessions.flatMap((sessionId) => {
        const stable = Object.entries(deps.transcripts.disclosures(sessionId)).filter(([key]) => !key.includes(PROVISIONAL_DISCLOSURE))
        return stable.length === 0 ? [] : [[sessionId, Object.fromEntries(stable)]]
      })),
      drafts: Object.fromEntries(Object.entries(drafts.drafts).map(([key, draft]) => [key, {
        text: draft.text,
        pastes: draft.pastes,
        attachments: draft.attachments,
        caret: draft.caret ?? draft.text.length,
      }])),
      questionDrafts: drafts.questionDrafts,
      modal: deps.overlay.route(),
      ...(outbox.length === 0 ? {} : { outbox }),
    }
  }

  async function restore(): Promise<void> {
    const needsCatalogLookup = handed?.foreground != null || (handed?.tabs.length ?? 0) > 0
    if (needsCatalogLookup && !deps.catalogReady()) {
      // An id lookup before the catalog arrives can time out during reconnect
      // and leave the terminal with tabs but no foreground.
      await new Promise<void>((resolve) => {
        onCleanup(resolve)
        createEffect(() => { if (deps.catalogReady()) resolve() })
      })
    }
    if (disposed) return
    // Each saved tab resolves on its own: one lookup that fails, such as a
    // read that times out during a reconnect, skips only that tab. A
    // version 1 predecessor can save a workflow's own tab; that tab opens its
    // root chat's tab once, and the workflow stays reachable from its card.
    // Remove the mapping to the root with the version 1 conversion in
    // `launch-state.ts`, after 2027-04-02.
    const tabs = handed?.tabs ?? []
    const routes = await Promise.allSettled(tabs.map((sessionId) => deps.resolveSessionRoute(sessionId)))
    if (disposed) return
    const roots = new Set<string>()
    for (const [index, settled] of routes.entries()) {
      if (settled.status === "rejected") {
        log.warn("saved tab skipped on restore", { sessionId: tabs[index], error: errorMessage(settled.reason) })
        continue
      }
      const route = settled.value
      if (route && !roots.has(route.root.id)) {
        roots.add(route.root.id)
        deps.openSessionTab(route.root.id)
      }
    }
    if (handed?.foreground == null) {
      await openFirstChat()
      return
    }
    let failure: { readonly cause: unknown } | undefined
    try {
      const { modal } = handed
      if (modal.kind === "child") await deps.activateSessionById(modal.sessionId)
      else if (modal.kind === "module") await deps.restoreModule(modal)
      else await deps.activateSessionById(handed.foreground)
    } catch (cause) {
      failure = { cause }
    }
    if (disposed) return
    // A foreground the runtime no longer has was reported, and one that could
    // not be read is reported after this; either way the terminal still
    // opens on a chat.
    const opened = deps.signals.foregroundId() !== undefined
    if (!opened) await openFirstChat()
    if (failure) throw failure.cause
    if (!opened) return
    const { modal } = handed
    if (modal.kind === "sessions") deps.reopen.sessions()
    else if (modal.kind === "theme") deps.reopen.theme()
  }

  return { restore }
}
