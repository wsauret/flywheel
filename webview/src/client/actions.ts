import { createRoot, createSelector, createSignal } from "solid-js"

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { AgentInputAnswer } from "../../../src/protocol/question-protocol-types.js"
import type { ProjectFileEntry, TranscriptSearchRequest, TranscriptSearchResult } from "../../../src/protocol/transcript-protocol-types.js"
import type { CommandOutcome } from "../../../src/protocol/command-catalog-protocol-types.js"
import type { CaptureSurfaceOpener } from "../../../src/protocol/client/surface-presentation.js"
import type { ProtocolChatAttachment, SessionTitlePatch } from "../../../src/protocol/app-service-types.js"
import type { LocalRecall } from "../../../src/protocol/client/chat-submissions.js"
import { routeSlashToken, type SlashRoute } from "../../../src/protocol/client/slash-route.js"
import { offCommandRefusal } from "../../../src/protocol/client/off-command.js"
import type { HostCapabilities } from "../host.js"
import { actionKey, controlActionKey } from "./action-key.js"
import { describeFailure } from "./failure-message.js"
import type { RuntimeSession } from "./session.js"
import type { SessionLink } from "./session-navigation.js"
import { desktopPermissionRefusal } from "./desktop-notifier.js"
import { DraftKeptRefusal } from "./session-input.js"
import { applyInlineSetting, settingKeys, type InlineSettingAction, type SettingOutcome } from "./settings-actions.js"
import type { MutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"

/** What owns a typed slash token: a command the catalog lists, or a refusal
 *  for a command that only a turned-off module provides or that is retired. */
export type SlashOwner = { readonly kind: "command" } | { readonly kind: "refused"; readonly refusal: string }

/** `/workflow:<id>` launched a named workflow in an earlier build. No
 *  workflow launches by name now, so a person who types it from habit hears
 *  that it is not a command, and the chat does not receive it as a message.
 *  Remove after 2027-04-30. */
function retiredWorkflowCommandRefusal(name: string): string | undefined {
  return /^workflow:/i.test(name) ? `Unknown command "/${name}". Ask the chat to write and launch a workflow.` : undefined
}

/** Everything the components can do, as one object.
 *
 *  Components never reach the reconciler or the host directly. Every action
 *  goes through here so a failed dispatch is reported once, in words, instead
 *  of being lost in a rejected promise nobody awaited: a user's message not
 *  arriving must never look like an agent that chose to ignore it.
 *
 *  This layer is also the one owner of what is in flight. An action that acts
 *  on something is recorded under its `actionKey` from the call until its
 *  result arrives, so the control that started it can show that it works. A
 *  call under a key that is already running joins that work and returns its
 *  result: five taps on one control make one request. Writes that each check
 *  what the one before them changed run in order instead, under a queue. */
export interface ClientActions {
  /** Runs `work` under `key` and reports a failure once, answering whether it
   *  succeeded. A call while `key` runs joins the running work instead. For a
   *  surface that dispatches on its own, such as a sheet or a module.
   *  `onFailure` replaces the generic report when the surface has its own
   *  words for the failure. */
  run<T>(key: string, work: () => Promise<T>, onFailure?: (cause: unknown) => void): Promise<boolean>
  /** Runs `work` under `key` after every running action of `queue`, for
   *  writes that each state what the one before them left. A call under
   *  `key` while it is the newest of its queue joins it; otherwise it waits
   *  its turn, so the latest choice lands last. `queue` reads working while
   *  any of its actions runs. */
  runInOrder<T>(queue: string, key: string, work: () => Promise<T>, onFailure?: (cause: unknown) => void): Promise<boolean>
  /** Whether an action under `key`, or any action of the queue `key`, is
   *  running. Reactive, and a reader wakes only when its own answer changes. */
  working(key: string): boolean
  /** Sends text and files, returning whether the runtime accepted them. Reports a failure once.
   *  Empty text is allowed when files are attached. */
  send(text: string, attachments?: readonly ProtocolChatAttachment[]): Promise<boolean>
  /** Interrupts or resumes the open session. Workflow targets select items or agents; omitted targets act on the whole workflow. */
  interrupt(targets?: readonly string[]): void
  resume(targets?: readonly string[]): void
  /** Stops a session that answers a parent's tool call. Terminal: it never resumes. */
  stop(sessionId: string): void
  /** Moves to a new chat at once. A tap while one is being created joins it
   *  in the session, which also moves the pane back to it. */
  newSession(): void
  /** Moves to `sessionId` at once. `link` is what the tap knew: the name the
   *  person tapped and the session the link sat in, which the pane shows
   *  until the session's own row says them. */
  selectSession(sessionId: string, link?: SessionLink): void
  removeSession(sessionId: string): void
  closeSession(sessionId: string): void
  renameSession(sessionId: string, patch: SessionTitlePatch): void
  /** Whether Close, Stop, Delete, or Rename of `sessionId` runs. Every
   *  surface that names the session reads it here, such as its list row and
   *  the open chat's title, so an action started anywhere shows on both.
   *  Reactive. */
  sessionWorking(sessionId: string): boolean
  loadOlder(): Promise<boolean>
  jumpToLatest(): void
  searchTranscripts(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>
  /** Project files and folders matching `query`, best first, for a mention. */
  projectFiles(query: string, limit: number): Promise<readonly ProjectFileEntry[]>
  /** Answers the identity of the block the transcript landed on, if any. */
  openAround(sessionId: string, entryId: string): Promise<string | undefined>
  compact(): void
  /** Runs a roster entry and presents whatever the runtime answered: in the
   *  open session, or with none open in the new chat it creates. */
  invokeCommand(name: string, args?: string): void
  /** Whether the command runs in `sessionId`, or with no session in the new
   *  chat that it creates. Once the runtime creates that chat, the command
   *  reads working there, and a tap there joins it. Reactive. */
  commandWorking(sessionId: string | undefined, name: string, args?: string): boolean
  /** Reports one dispatch of a slash command to the runtime's shared ranking. */
  recordCommandUse(name: string): void
  /** Routes a typed slash token by the session's command catalog, through the
   *  rule every client shares (`routeSlashToken`): a token the catalog lists
   *  is a command, a token only a turned-off module provides answers that
   *  module's refusal, and before the catalog arrives any other token waits
   *  for it. */
  routeSlashCommand(name: string): SlashRoute<SlashOwner>
  answer(toolUseId: string, answers: { readonly [question: string]: AgentInputAnswer }): void
  cancelQuestion(toolUseId: string): void
  terminateBackground(toolUseId: string): void
  detachBash(toolUseId: string): void
  hydrateBody(blockId: string): void
  /** The selected transcript's passive, resident file-evidence reader. */
  readonly mutationEvidence: MutationEvidenceReader | undefined
  hydrateGroup(groupBlockId: string): void
  dismissNotice(scope: string): void
  recallQueued(): Promise<string | undefined>
  /** Up and a message's Edit control: takes the message `entryId` names, or
   *  the newest one that did not go through, out of the transcript for the
   *  composer to edit and send again. A message that waits for the
   *  connection stays, and this reports why. Local: it never waits on the
   *  runtime. */
  recallLocal(entryId?: string): LocalRecall | undefined
  /** Applies one setting change and reports its outcome, which is also
   *  returned so a surface that shows refusals in place can. */
  applySetting(action: InlineSettingAction): Promise<SettingOutcome>
  reconnect(): void
  /** Host reach. Each is a no-op that reports nothing when the host lacks the
   *  capability, because the components already hide the control. */
  readonly canOpenFiles: boolean
  openFile(path: string, asDiff?: boolean): void
  readonly canOpenExternal: boolean
  openExternal(url: string): void
  hasHostCommand(id: string): boolean
  runHostCommand(id: string, ...args: readonly unknown[]): void
  /** Ends the reactive root that the working readers subscribe through. The
   *  host that created the actions calls it once, when it unmounts the
   *  client, after which no reader wakes again. */
  dispose(): void
}

export interface ClientActionDeps {
  readonly session: RuntimeSession
  readonly connection: RuntimeConnection
  readonly capabilities: HostCapabilities
  /** Puts a message in front of the person. Warnings are failures they can act
   *  on; info is a saved setting with a caveat. */
  readonly report: (severity: "info" | "warning", message: string) => void
  /** Captures the placement and opening intent before a runtime invocation. */
  readonly captureSurfaceOpener: CaptureSurfaceOpener
}

/** The editor command that opens one changed file as a diff. Named here because
 *  it is the one place the client asks a host for a diff by command id rather
 *  than through a typed capability. */
const OPEN_CHANGE_DIFF = "flywheel.openChangeDiff"

/** The actions on a session itself, which every surface that names the
 *  session shows as working. */
const SESSION_ACTIONS = ["close", "stop", "delete", "rename"] as const

export function createClientActions(deps: ClientActionDeps): ClientActions {
  const { session, capabilities } = deps
  const commands = capabilities.commands

  const reportFailure = (cause: unknown): void => {
    deps.report("warning", `Flywheel could not complete that action: ${describeFailure(cause)}`)
  }
  /** Runs an action, and says so when it fails. */
  const attempt = async <T>(work: () => Promise<T>, onFailure = reportFailure): Promise<boolean> => {
    try {
      await work()
      return true
    } catch (cause: unknown) {
      onFailure(cause)
      return false
    }
  }

  /** The one ledger of running actions, in the order they started. An entry
   *  in a queue runs after the entries of that queue before it. */
  interface Running { readonly queue: string | undefined; readonly work: Promise<unknown> }
  const ledger = new Map<string, Running>()
  const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set())
  const publish = () => setRunning(new Set([...ledger].flatMap(([key, { queue }]) => (queue === undefined ? [key] : [key, queue]))))
  // Per key, so a start or an end wakes only the readers whose answer
  // changed. The root lives as long as the client that owns the actions.
  const [isRunning, disposeSelector] = createRoot((dispose) => [createSelector(running, (key: string, keys: ReadonlySet<string>) => keys.has(key)), dispose] as const)

  /** The first call under a key starts the work; a call while it runs gets
   *  the same promise. In a queue, only the newest entry is joined, and new
   *  work starts after every running entry of the queue. */
  function join<T>(key: string, start: () => Promise<T>, queue?: string): Promise<T> {
    const ahead = queue === undefined ? [] : [...ledger.values()].filter((entry) => entry.queue === queue)
    const joined = ledger.get(key)
    if (joined !== undefined && (queue === undefined || ahead.at(-1) === joined)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- one key always names one action, whose call started this work with this result type
      return joined.work as Promise<T>
    }
    const begun = ahead.length === 0 ? start() : Promise.allSettled(ahead.map((entry) => entry.work)).then(start)
    const work: Promise<T> = begun.finally(() => {
      if (ledger.get(key)?.work === work) ledger.delete(key)
      publish()
    })
    // Deleted first so a replaced key moves to the end of the start order.
    ledger.delete(key)
    ledger.set(key, { queue, work })
    publish()
    return work
  }
  /** An attempt recorded under `key`, for an action that acts on something. */
  const perform = <T>(key: string, work: () => Promise<T>, onFailure?: (cause: unknown) => void): Promise<boolean> =>
    join(key, () => attempt(work, onFailure))
  /** The selected session, for a control that acts on whichever one is open. */
  const selected = () => session.sessionId ?? ""

  /** Resolves once the connection answers again after the request leaves the
   *  current lane, or when it closes. A lane that is up first goes down and
   *  comes back, so the first "connected" seen after leaving it is the answer. */
  const reconnected = (): Promise<void> => new Promise((resolve) => {
    if (deps.connection.state === "closed") {
      resolve()
      return
    }
    let left = deps.connection.state !== "connected"
    const stop = deps.connection.onStateChange((state) => {
      if (state !== "connected" && state !== "closed") {
        left = true
        return
      }
      if (state === "closed" || left) {
        stop()
        resolve()
      }
    })
    deps.connection.reconnect()
  })

  /** One affordance per outcome variant; no branch reads a command id. */
  const present = (outcome: CommandOutcome, openSurface: ReturnType<CaptureSurfaceOpener>): void => {
    switch (outcome.kind) {
      case "none":
      case "focus-session": return
      case "message": deps.report("info", outcome.message); return
      case "warning":
      case "unavailable": deps.report("warning", outcome.message); return
      case "open": openSurface(outcome.surface, outcome.sessionId); return
      case "stale": deps.report("warning", "Commands changed, try again")
    }
  }

  // Keyed by the session the command runs in: the same command in another
  // session is its own action. With no chat open it waits for the new chat
  // under the key of no session, then runs under the created chat's key.
  // The first key ends as the second starts, so the same command in a
  // later new chat runs there. A command whose whole effect is a surface
  // opens it at once, with no chat and no runtime call, so it opens also
  // while the runtime does not answer.
  const invokeKnown = (name: string, args: string | undefined): void => {
    const builtIn = session.commands.builtIn(name)
    if (builtIn?.opens !== undefined) { deps.captureSurfaceOpener()(builtIn.opens, undefined, { ...(builtIn.target === undefined ? {} : { target: builtIn.target }), ...(args === undefined || args === "" ? {} : { argument: args }) }); return }
    const command = (target: string) => perform(actionKey("command", target, name, args), async () => {
      const openSurface = deps.captureSurfaceOpener()
      present(await session.invokeCommand(target, name, args), openSurface)
    })
    const open = session.sessionId
    if (open !== undefined) void command(open)
    else void join(actionKey("command", undefined, name, args), () => session.newChat().then((target) => { void command(target) }, reportFailure))
  }

  return {
    run: perform,
    runInOrder: (queue, key, work, onFailure) => join(key, () => attempt(work, onFailure), queue),
    working: isRunning,
    send: (text, attachments) => attempt(() => session.send(text, attachments), (cause) => {
      if (cause instanceof DraftKeptRefusal) deps.report("warning", cause.message)
      else reportFailure(cause)
    }),
    interrupt: (targets) => perform(controlActionKey("interrupt", selected(), targets), () => session.interrupt(targets)),
    resume: (targets) => perform(controlActionKey("resume", selected(), targets), () => session.resume(targets)),
    stop: (sessionId) => perform(actionKey("stop", sessionId), () => session.stop(sessionId)),
    // Every tap reaches the session, because each tap moves the pane; the
    // session joins the one creation, so this only shows that it works.
    newSession: () => {
      const opening = session.openNew()
      void perform(actionKey("new-chat"), () => opening)
    },
    selectSession: (sessionId, link) => attempt(() => session.select(sessionId, link)),
    removeSession: (sessionId) => perform(actionKey("delete", sessionId), () => session.remove(sessionId)),
    closeSession: (sessionId) => perform(actionKey("close", sessionId), () => session.close(sessionId)),
    renameSession: (sessionId, patch) => perform(actionKey("rename", sessionId), () => session.rename(sessionId, patch)),
    sessionWorking: (sessionId) => SESSION_ACTIONS.some((action) => isRunning(actionKey(action, sessionId))),
    loadOlder: () => join(actionKey("load-older", selected()), () => session.loadOlder().catch((cause: unknown) => {
      reportFailure(cause)
      return false
    })),
    searchTranscripts: (request) => session.searchTranscripts(request),
    projectFiles: async (query, limit) => {
      try {
        return (await session.projectFiles({ query, limit })).entries
      } catch (cause) {
        deps.report("warning", `Flywheel could not list the project's files: ${describeFailure(cause)}`)
        return []
      }
    },
    openAround: async (sessionId, entryId) => {
      try {
        return await session.openAround(sessionId, entryId)
      } catch (cause) {
        deps.report("warning", `Flywheel could not open that place: ${describeFailure(cause)}`)
        return undefined
      }
    },
    jumpToLatest: () => attempt(async () => { await session.transcript?.jumpToLatest() }),
    compact: () => perform(actionKey("compact", selected()), () => session.compact()),
    // A host palette command can arrive before the command catalog. It waits
    // for the catalog, so a command that opens a surface opens it at its
    // target instead of asking the runtime.
    invokeCommand: (name, args) => {
      if (session.commands.known()) invokeKnown(name, args)
      else void session.commands.arrived.then(() => { invokeKnown(name, args) })
    },
    commandWorking: (sessionId, name, args) => isRunning(actionKey("command", sessionId, name, args)),
    recordCommandUse: (name) => attempt(() => session.recordCommandUse(name)),
    routeSlashCommand: (name) => routeSlashToken(session.commands, (): SlashOwner | undefined => {
      // The roster itself, not a view built from it, so the answer and the
      // catalog's arrival come from the one source.
      if (session.commands.builtIn(name) !== undefined) return { kind: "command" }
      const refusal = offCommandRefusal(session.commands.offCommands, name) ?? retiredWorkflowCommandRefusal(name)
      return refusal === undefined ? undefined : { kind: "refused", refusal }
    }),
    answer: (toolUseId, answers) => perform(actionKey("answer", toolUseId), () => session.answer(toolUseId, answers)),
    cancelQuestion: (toolUseId) => perform(actionKey("skip", toolUseId), () => session.cancelQuestion(toolUseId)),
    terminateBackground: (toolUseId) => perform(actionKey("stop-tool", toolUseId), () => session.terminateBackground(toolUseId)),
    detachBash: (toolUseId) => perform(actionKey("detach", toolUseId), () => session.detachBash(toolUseId)),
    hydrateBody: (blockId) => attempt(async () => { await session.transcript?.hydrateBody(blockId) }),
    get mutationEvidence() { return session.transcript?.mutationEvidence },
    hydrateGroup: (groupBlockId) => attempt(async () => { await session.transcript?.hydrateGroup(groupBlockId) }),
    dismissNotice: (scope) => {
      const sessionId = session.sessionId
      void perform(actionKey("dismiss-notice", sessionId, scope), () => session.dismissNotice(sessionId, scope))
    },
    recallLocal: (entryId) => {
      const recalled = session.recallLocal(entryId)
      if (recalled?.kind === "waiting") deps.report("info", recalled.notice)
      return recalled
    },
    recallQueued: () => join(actionKey("recall-queued", selected()), () => session.recallQueued().catch((cause: unknown) => {
      deps.report("warning", `Flywheel could not recall the queued message: ${describeFailure(cause)}`)
      return undefined
    })),
    applySetting: (action) => join(settingKeys(action).write, async () => {
      // Read when the write runs, not at the tap: a write queued behind
      // another one for the setting states what that write left.
      const current = session.settings
      let outcome: SettingOutcome
      if (current === undefined) {
        // A sheet can show a control before the first settings read lands, or
        // after it failed. The read below gives the next tap what it needs.
        outcome = { kind: "notice", severity: "warning", message: "Flywheel did not change that setting: it has not read the settings yet. Try again in a moment." }
      } else {
        try {
          // The browser asks for its permission inside the tap that turns
          // desktop notifications on, before the first await, or it refuses.
          outcome = await desktopPermissionRefusal(action, session.desktopNotifier) ?? await applyInlineSetting(deps.connection, action, current, session.update?.autoInstall)
        } catch (cause) {
          outcome = { kind: "notice", severity: "warning", message: `Flywheel did not change that setting: ${describeFailure(cause)}` }
        }
      }
      if (outcome.kind === "notice") deps.report(outcome.severity, outcome.message)
      // The snapshot re-reads immediately so an in-place toggle repaints in the
      // same beat, rather than on the next config patch.
      await session.refreshSettings()
      return outcome
    }, settingKeys(action).row),
    reconnect: () => perform(actionKey("reconnect"), reconnected),
    canOpenFiles: capabilities.openFile !== undefined,
    openFile(path, asDiff) {
      // Paths in a transcript are relative to where the session executes, and
      // the runtime is the authority on that directory (ARCH-DIRECTORIES-007). The host
      // contains the path under it before touching the filesystem.
      const base = session.executionCwd
      if (base === undefined) return
      if (asDiff === true) {
        // What changed is the question a reader of a mutation row has, and the
        // file on its own does not answer it.
        if (commands?.has(OPEN_CHANGE_DIFF)) attempt(() => commands.run(OPEN_CHANGE_DIFF, path))
        return
      }
      if (capabilities.openFile) attempt(() => capabilities.openFile!(path, base))
    },
    canOpenExternal: capabilities.openExternal !== undefined,
    openExternal(url) {
      if (capabilities.openExternal) attempt(() => capabilities.openExternal!(url))
    },
    hasHostCommand: (id) => commands?.has(id) ?? false,
    runHostCommand(id, ...args) {
      if (commands?.has(id)) attempt(() => commands.run(id, ...args))
    },
    dispose: disposeSelector,
  }
}
