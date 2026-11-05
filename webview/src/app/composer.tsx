import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { offeredControls, summaryOf } from "../client/view-state.js"
import { actionKey, controlActionKey } from "../client/action-key.js"
import { useClient } from "./client-context.js"
import { changesLabel } from "../client/changes-label.js"
import { createCommandPanel } from "./command-panel.js"
import { commandRefusal } from "./surfaces.js"
import { insertMention, mentionAt } from "../../../src/protocol/client/mention.js"
import { offCommandRefusal } from "../../../src/protocol/client/off-command.js"
import { UNKNOWN_COMMAND_NOTICE, type SettledSlashRoute } from "../../../src/protocol/client/slash-route.js"
import type { SlashOwner } from "../client/actions.js"
import { sessionControls } from "../../../src/protocol/client/session-controls.js"
import type { ConversationInput } from "../web-module-client.js"
import { createMentionPanel } from "./mention-panel.js"
import { createAttachMenu } from "./attach-menu.js"
import { createComposerAttachments, transferredFiles } from "./attachments.js"
import { formatBytes } from "../../../src/protocol/client/attachments.js"
import { CLAIMED_ELSEWHERE, isBareTypingKey } from "./composer-claim.js"
import { Icon, ICONS } from "./icons.js"
import type { FrontendQuestionBlock } from "../client/question-answer.js"
import { createQuestionAttention, createQuestionInteractions, QuestionPanel } from "./question-panel.js"
import { publishPaneHeight } from "./transcript-scroll.js"
import { createSessionReading } from "./session-reading.js"
import { sessionServingSelection, type RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import type { ActiveModel } from "../client/active-model.js"
import type { SessionRow } from "../../../src/protocol/app-service-types.js"
import "../styles/composer.css"
import { ComposerCheckpointSchema, type ComposerCheckpoint } from "../client/input-reload-checkpoint.js"
import { Schema } from "effect"
import { createComposerSessionDrafts } from "./composer-session-drafts.js"

/** A slash command as typed: its token and the words after it. */
interface SlashCommand {
  readonly name: string
  readonly args: string
}

/** What the app can ask the composer to do from outside it. */
export interface ComposerHandle {
  capture(): ComposerCheckpoint
  adopt(checkpoint: unknown): void
  settled(): Promise<void>
  focus(): void
  insertText(text: string): void
  appendInput(sessionId: string, input: import("../../../src/protocol/app-service-types.js").ProtocolChatInputObject): void
  /** Puts `/` in the draft, which opens the command panel. */
  openCommands(): void
  /** Starts an `@` at the caret, which opens the file picker. */
  openMentions(): void
  /** Opens the device's file chooser; what it picks attaches to the next message. */
  pickFiles(): void
  /** Takes the message `entryId` names, or the newest one that did not go
   *  through, out of the transcript and puts its words and files here for
   *  editing, after any draft. A message that waits for the connection
   *  stays, and the page says why. */
  recallLocal(entryId?: string): void
}

/** Child viewers name the runtime's serving reading, never a sibling or Chat role. */
export function composerModel(kind: SessionRow["kind"] | undefined, childRoles: RoleAssignmentView | undefined, activeModel: ActiveModel | undefined): ActiveModel | undefined {
  return kind === "subagent" || kind === "workflow-agent" ? sessionServingSelection(childRoles) : activeModel
}

/** The composer: the primary affordance, and the one place the keyboard lives.
 *
 *  Enter sends and Shift+Enter breaks a line, because this is a chat input
 *  first and a text editor second. Arrow keys at the edges of the text walk
 *  history the way a shell does; a leading slash opens the command panel and
 *  the panel owns its keys while it is open. Escape skips a docked question,
 *  and with none it interrupts a running turn, the way it does in the terminal. */
export function Composer(props: {
  readonly register: (handle: ComposerHandle) => void
  /** Module-owned input copy and restrictions for this conversation. */
  readonly input?: () => ConversationInput | undefined
}) {
  const client = useClient()
  const state = client.state
  const submissionHeld = () => client.submissionHeld?.() === true
  const interrupt = () => { if (offeredControls(state(), selectedRow()).primary === "interrupt") client.actions.interrupt() }
  /** Whether a run control's action on the open session waits on the runtime. */
  const working = (control: "interrupt" | "resume" | "stop") => {
    const sessionId = state().sessionId
    return client.actions.working(control === "stop" || sessionId === undefined ? actionKey(control, sessionId) : controlActionKey(control, sessionId)) || undefined
  }
  /** The command, launch, or recall the composer last started: whether it
   *  runs in a session, as the actions layer answers, and the words that name
   *  it. The composer keeps only which one it started, because the draft that
   *  named it is gone once the composer clears. It shows only in the session
   *  it runs in, because one composer serves every session. */
  const [started, setStarted] = createSignal<{ readonly runs: (sessionId: string | undefined) => boolean; readonly label: string }>()
  const startedRunning = (): string | undefined => {
    const action = started()
    return action !== undefined && action.runs(state().sessionId) ? action.label : undefined
  }
  /** Whether a command the composer took waits for the command catalog. */
  const [awaitingCatalog, setAwaitingCatalog] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  // Where the caret is, kept beside the draft: the `@` picker reads the token
  // the caret is in, which the text alone cannot say.
  const [caret, setCaret] = createSignal(0)
  let composer: HTMLTextAreaElement | undefined
  const syncCaret = (): void => { if (composer) setCaret(composer.selectionStart) }

  /** Files waiting to ride with the next message, from the chooser, a paste,
   *  or a drop. A file that cannot attach is reported in words and skipped. */
  const attachments = createComposerAttachments((message) => client.report("warning", message))
  /** Adds files to the draft. An agent view's composer takes words only,
   *  so it says that and adds nothing. */
  const addFiles = (files: readonly File[]) => {
    if (props.input?.()?.wordsOnly) {
      client.report("warning", "This message takes words only, so the file was not added.")
      return
    }
    void attachments.add(files)
  }
  let fileInput: HTMLInputElement | undefined
  const [dropping, setDropping] = createSignal(false)
  const pickFiles = (): void => fileInput?.click()
  const attachMenu = createAttachMenu({
    rows: [
      { id: "add-files", label: "Attach files", description: "Attach images or text files from this device", run: pickFiles },
      { id: "mention-file", label: "Mention a project file", description: "Put a project file's path into the message for the agent to read", run: () => handle.openMentions() },
    ],
  })

  const selectedRow = () => summaryOf(state(), state().sessionId)
  const child = () => selectedRow()?.kind === "subagent" || selectedRow()?.kind === "workflow-agent"
  const childSessionId = createMemo(() => child() ? state().sessionId : undefined)
  const roleAssignments = untrack(() => ({
    get: state().roleAssignments,
    subscribe: state().subscribeRoleAssignments,
  }))
  const childRoles = createSessionReading(childSessionId, roleAssignments)
  const displayedModel = () => composerModel(selectedRow()?.kind, childRoles(), state().activeModel)
  // Interrupt, Resume, and Stop for the open session, whatever its kind,
  // from its row, the one reader of what the runtime admits (ARCH-PROTOCOL-050,
  // PI-INTERACTION-043, PI-INTERACTION-103, PI-INTERACTION-044, PI-INTERACTION-115, PI-AGENT-020); the composer
  // holds no control state of its own. Interrupt is offered only while
  // there is something to interrupt and Resume only while there is not: the
  // row admits both from durable evidence, and the live status says which
  // applies now.
  const controls = () => {
    const offered = offeredControls(state(), selectedRow())
    const primary = offered.primary
    return { message: sessionControls(selectedRow()).message, interrupt: primary === "interrupt", resume: primary === "resume", stop: offered.stop }
  }
  const editable = () => !child() || controls().message
  const composerPlaceholder = () => {
    const running = startedRunning()
    if (running !== undefined) return running
    const input = props.input?.()
    if (input !== undefined) return input.placeholder
    if (child()) return controls().message ? `Message this ${selectedRow()?.kind}` : `This ${selectedRow()?.kind} is read-only`
    return "Type your task here"
  }

  /** The composer's height follows its content up to the CSS ceiling, past
   *  which the textarea scrolls on its own. One effect covers every path that
   *  sets the draft (typing, a suggestion, an inserted selection) rather than
   *  each call site remembering to resize. */
  function grow(element: HTMLTextAreaElement): void {
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }
  createEffect(() => {
    draft()
    if (composer) grow(composer)
  })

  /** A draft that is a slash command, split into token and arguments.
   *
   *  Only a leading slash counts, and only before the first newline: a message
   *  whose second paragraph starts with a path is still a message. */
  const asCommand = (): SlashCommand | undefined => {
    const text = draft()
    if (!text.startsWith("/")) return undefined
    const firstLine = text.split("\n", 1)[0] ?? ""
    const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(text)
    if (!match || firstLine.length === 0) return undefined
    return { name: match[1] ?? "", args: (match[2] ?? "").trim() }
  }

  /** Attachments make the draft a message. A known catalog token followed by
   *  whitespace starts command arguments. Other single-line slash text stays
   *  searchable as an action label. */
  const questionAttention = createQuestionAttention(client, draft)
  const isBuiltInToken = (token: string) => state().builtInCommands.some((command) => command.id === token || command.aliases.includes(token))
  const panelQuery = createMemo((): string | undefined => {
    const text = draft()
    if (questionAttention.panelHidden() || attachments.items().length > 0 || !text.startsWith("/") || text.includes("\n")) return undefined
    const command = /^\/(\S+)\s/.exec(text)?.[1]
    if (command !== undefined && isBuiltInToken(command)) return undefined
    // A command a turned-off module provides, typed exactly and owned by no
    // built-in, is the person's whole intent: no menu lists it, so Enter
    // answers its refusal rather than a fuzzy panel row.
    const typed = text.slice(1)
    if (!isBuiltInToken(typed) && offCommandRefusal(state().offCommands, typed) !== undefined) return undefined
    return typed
  })

  const panel = createCommandPanel({
    client,
    query: panelQuery,
    // Clears the draft only. Focus is already in the composer when the panel
    // closes from its keyboard, a mousedown pick never moved it, and a row
    // that opened a sheet has just handed it to the sheet, which pulling it
    // back would hide behind the modal.
    close: () => setDraft(""),
  })

  const mention = createMentionPanel({
    client,
    token: () => mentionAt(draft(), caret()),
    pick: (entry) => {
      const token = mentionAt(draft(), caret())
      if (!token) return
      const next = insertMention(draft(), token, entry.path, entry.directory)
      setDraft(next.text)
      composer?.focus()
      composer?.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    },
  })

  /** Where in history the composer currently is: -1 is the live draft, 0 the
   *  most recent message, upwards into the past. */
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  /** What was being written before history was entered, so leaving history
   *  gives it back rather than discarding it. */
  let heldDraft = ""

  /** Each session keeps its own unsent words and files in its memory while
   *  the page keeps it resident, so a person who checks another session and
   *  comes back finds the message as they left it, and words typed for one
   *  session never go to another. The new chat's pane keeps its own while no
   *  session is open, and the chat its first message creates takes over
   *  what the person typed while the runtime created it. */
  const activeDraft = () => ({ text: draft(), attachments: attachments.toInput("").attachments })
  const subagentFinished = () => {
    const row = selectedRow(); return row?.kind === "subagent" && (row.runOutcome === "completed" || row.runOutcome === "partial")
  }
  const drafts = createComposerSessionDrafts({
    sessionId: () => state().sessionId, parentSessionId: () => state().rootSessionId, created: () => client.residents.destination.created === true,
    finished: () => state().windowCurrent && subagentFinished(), memory: client.residents.memory, read: activeDraft,
    write: (input) => { setDraft(input.text); attachments.adopt(input.attachments ?? []) }, resetHistory: () => setHistoryIndex(-1),
    send: (input) => client.actions.send(input.text, input.attachments),
    report: () => client.report("info", "This subagent finished. Your unsent draft is in the parent chat's composer."),
  })
  const focusKey = (action: string, item?: string) => JSON.stringify(["composer", state().sessionId ?? null, action, item])

  /** Messages this person has sent, newest first. Read from the transcript
   *  rather than kept as a private list, so it is the same history after a
   *  reload, after switching chats, and after a message sent from elsewhere. */
  const history = () => {
    const sent: string[] = []
    for (const block of state().blocks) {
      if (block.kind !== "userMessage") continue
      const text = block.content.trim()
      // Consecutive duplicates are noise to arrow through, the same as a shell
      // collapsing them.
      if (text.length > 0 && text !== sent[0]) sent.unshift(text)
    }
    return sent
  }

  function moveHistory(delta: number): boolean {
    const entries = history()
    if (entries.length === 0) return false
    const next = historyIndex() + delta
    if (next < -1 || next >= entries.length) return false
    if (historyIndex() === -1 && next >= 0) heldDraft = draft()
    setHistoryIndex(next)
    setDraft(next === -1 ? heldDraft : entries[next] ?? "")
    // The caret goes to the end, which is where someone editing a recalled
    // message wants it, and which also stops the next ArrowUp from firing
    // immediately on a multi-line entry.
    queueMicrotask(() => {
      if (!composer) return
      composer.focus()
      const end = composer.value.length
      composer.setSelectionRange(end, end)
    })
    return true
  }

  /** True when the caret sits on the first line, so ArrowUp has nowhere left to
   *  go inside the text and can mean history instead. */
  function atFirstLine(field: HTMLTextAreaElement | undefined): boolean {
    if (!field) return false
    return field.value.lastIndexOf("\n", Math.max(0, field.selectionStart - 1)) === -1
  }
  function atLastLine(field: HTMLTextAreaElement | undefined): boolean {
    if (!field) return false
    return !field.value.includes("\n", field.selectionEnd)
  }

  const clear = () => {
    setDraft("")
    setHistoryIndex(-1)
    heldDraft = ""
    if (composer) composer.style.height = "auto"
  }

  const submit = () => {
    if (submissionHeld()) return
    if (child() && !controls().message) return
    const text = draft().trim()
    const attached = attachments.items().length > 0
    // A message with files is a message, even when its words start with a
    // slash, as in the terminal. Any other leading token is a command in
    // every view, so an agent view refuses an unknown one too (PI-INTERACTION-081).
    const command = attached ? undefined : asCommand()
    if (command !== undefined) { submitCommand(command, text); return }
    if (selectedRow()?.kind === "subagent") { drafts.submitChild(); return }
    // An agent view's message is words for one item or agent: no file,
    // because an agent reads text only.
    if (props.input?.()?.wordsOnly) {
      if (text.length === 0) return
      clear()
      // A refused message comes back into an empty composer, so the
      // person can address it again.
      void client.actions.send(text).then((sent) => { if (!sent && draft().length === 0) setDraft(text) })
      return
    }
    if (text.length === 0 && !attached) return
    sendDraft(text)
  }

  function submitCommand(command: SlashCommand, text: string): void {
    const routing = client.actions.routeSlashCommand(command.name)
    if (routing.kind !== "waiting") {
      settleSlash(routing, command, text, false)
      return
    }
    // The command catalog has not arrived, so the composer cannot yet tell a
    // command from words. It takes the command at once, shows that it runs,
    // and decides once the catalog is known.
    clear()
    setAwaitingCatalog(true)
    setStarted({ runs: awaitingCatalog, label: `Running /${command.name}…` })
    void routing.settled.then((settled) => {
      setAwaitingCatalog(false)
      settleSlash(settled, command, text, true)
    })
  }

  /** Acts on a routed slash command. `taken` says the composer already
   *  cleared it while the catalog loaded: a refusal then puts the words back
   *  into an empty composer, and words that are a message go out without
   *  touching what the person has typed since. */
  function settleSlash(settled: SettledSlashRoute<SlashOwner>, command: SlashCommand, text: string, taken: boolean): void {
    const refusal = settled.kind === "loading" ? settled.notice : settled.kind === "unowned" ? UNKNOWN_COMMAND_NOTICE
      : settled.route.kind === "refused" ? settled.route.refusal : commandRefusal(client, command.name)
    if (refusal === undefined) { runCommand(command); if (!taken) clear(); return }
    // Refused like the terminal does: the draft stays, so nothing typed is
    // lost, and it is never sent as a message.
    client.report("warning", refusal)
    if (taken && draft().length === 0) setDraft(text)
  }

  function runCommand(command: SlashCommand): void {
    // Invoked rather than sent: a built-in executes in the runtime and
    // answers an outcome, which sending the raw text would not.
    setStarted({ runs: (sessionId) => client.actions.commandWorking(sessionId, command.name, command.args), label: `Running /${command.name}…` })
    client.actions.invokeCommand(command.name, command.args)
    // The client dispatched it, so the client reports it: the runtime keeps
    // the count every client ranks by, but only this side knows it ran.
    client.actions.recordCommandUse(command.name)
  }

  function sendDraft(text: string): void {
    const input = attachments.toInput(text)
    // The message shows in the transcript at once, as queued, so the
    // composer clears in the same tap: in the open session, or with none
    // open in the new chat the send moves to. A failed send stays there,
    // marked as not delivered, until the person takes it back to edit.
    for (const item of attachments.items()) attachments.remove(item.marker)
    clear()
    void client.actions.send(input.text, input.attachments)
  }

  /** A message that did not go through, taken back from the transcript with
   *  its files. Up on an empty composer takes the newest before anything
   *  else, the way the terminal does; a message's Edit control takes that
   *  message. True when Up ends here: a message that waits for the
   *  connection stays where it is, and the action says why. */
  function recallLocal(entryId?: string): boolean {
    const recalled = client.actions.recallLocal(entryId)
    if (recalled?.kind !== "input") return recalled !== undefined
    const text = attachments.restore({ text: recalled.input.text, attachments: recalled.input.attachments ?? [] })
    setHistoryIndex(-1)
    setDraft((current) => (current.length === 0 ? text : text.length === 0 ? current : `${current}\n${text}`))
    queueMicrotask(() => {
      if (!composer) return
      composer.focus()
      const end = composer.value.length
      composer.setSelectionRange(end, end)
    })
    return true
  }

  /** The message the runtime is holding for the next turn, recalled into the
   *  composer for editing. Up on an empty draft while the agent is working, the
   *  way the terminal does it; when nothing was queued, Up falls through to
   *  history. */
  async function recallQueued(): Promise<boolean> {
    setStarted({ runs: (sessionId) => client.actions.working(actionKey("recall-queued", sessionId)), label: "Recalling the queued message…" })
    const text = await client.actions.recallQueued()
    if (text === undefined) return false
    setDraft(text)
    composer?.focus()
    return true
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (mention.onKeyDown(event)) return
    if (panel.onKeyDown(event)) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
      return
    }
    const question = pendingQuestion()
    if (event.key === "Escape" && question !== undefined) {
      // Escape skips the question at the prompt; it interrupts only while no
      // question waits (PI-INTERACTION-009, PI-INTERACTION-043).
      event.preventDefault()
      if (state().windowCurrent) questionInteractions.skip(client.actions, question.sessionId, question.block)
      return
    }
    if (event.key === "Escape" && controls().interrupt) {
      // An open agent keeps its scope even when its address is unavailable.
      event.preventDefault()
      interrupt()
      return
    }
    if (event.key === "ArrowUp" && atFirstLine(composer)) {
      if (draft().length === 0 && attachments.items().length === 0 && recallLocal()) {
        event.preventDefault()
        return
      }
      if (draft().length === 0 && state().busy) {
        event.preventDefault()
        void recallQueued().then((recalled) => { if (!recalled) moveHistory(1) })
        return
      }
      if (moveHistory(1)) event.preventDefault()
      return
    }
    if (event.key === "ArrowDown" && atLastLine(composer) && moveHistory(-1)) event.preventDefault()
  }

  const handle: ComposerHandle = {
    appendInput: drafts.appendInput,
    settled: attachments.settled,
    capture: () => ({ ...drafts.capture(), active: activeDraft(), questions: questionInteractions.capture() }),
    adopt: (bytes) => {
      const saved = Schema.decodeUnknownSync(ComposerCheckpointSchema)(bytes)
      const active = drafts.adopt(saved)
      questionInteractions.adopt(saved.questions)
      attachments.adopt(active?.attachments ?? [])
      setDraft(active?.text ?? "")
    },
    focus: () => composer?.focus(),
    insertText: (text) => {
      setDraft((current) => (current.length === 0 ? text : `${current}\n${text}`))
      composer?.focus()
    },
    openCommands: () => {
      setDraft("/")
      composer?.focus()
    },
    pickFiles,
    recallLocal: (entryId) => { recallLocal(entryId) },
    openMentions: () => {
      // A bare slash query is the command panel's, not a message: the row
      // that got here replaces it rather than mentioning a file after it.
      const current = /^\/\S*$/.test(draft()) ? "" : draft()
      const next = current.length === 0 || /\s$/.test(current) ? `${current}@` : `${current} @`
      setDraft(next)
      composer?.focus()
      composer?.setSelectionRange(next.length, next.length)
      setCaret(next.length)
    },
  }

  // Typing from anywhere lands here, as it does in the TUI. Focus moves in
  // keydown, before the browser inserts the character, so the key itself
  // becomes the first thing in the draft rather than being dropped.
  const claim = (event: KeyboardEvent) => {
    if (!composer || composer.closest("[inert]") || document.activeElement === composer || !isBareTypingKey(event)) return
    if (event.target instanceof Element && event.target.closest(CLAIMED_ELSEWHERE)) return
    composer.focus()
    const end = composer.value.length
    composer.setSelectionRange(end, end)
  }
  document.addEventListener("keydown", claim)
  onCleanup(() => document.removeEventListener("keydown", claim))

  const changedFiles = () => changesLabel(state().changes?.summary)
  const changedCount = () => {
    const summary = state().changes?.summary
    return summary !== undefined && "data" in summary ? summary.data?.fileCount : undefined
  }
  /** The question the agent is waiting on, if any. It docks here, as in the
   *  TUI; the command panel takes precedence while a slash is being typed. A
   *  child asks its parent, never the person, so a child's pane docks none. */
  const questionInteractions = createQuestionInteractions()
  props.register(handle)
  // The question projection is the one authority on what waits (ARCH-PROTOCOL-068):
  // every settlement path advances it, including one no live transcript patch
  // reports. Once a current reading no longer names the question a session
  // docked, its picks retire, so an old window that shows it again starts clean.
  const dockedBySession = new Map<string, string>()
  createEffect(() => {
    const { windowCurrent, sessionId, pendingQuestion: waiting } = state()
    if (!windowCurrent || sessionId === undefined) return
    const docked = dockedBySession.get(sessionId)
    if (docked !== undefined && docked !== waiting?.toolUseId) questionInteractions.forget(sessionId, docked)
    if (waiting === undefined) dockedBySession.delete(sessionId)
    else dockedBySession.set(sessionId, waiting.toolUseId)
  })
  const pendingQuestion = createMemo<{ readonly sessionId: string; readonly block: FrontendQuestionBlock } | undefined>((previous) => {
    const sessionId = state().sessionId
    if (child() || sessionId === undefined) return undefined
    // A kept window shown before its merge may name a question another
    // client already answered. Keep its form, but hold settlement until current.
    if (!state().windowCurrent && previous?.sessionId === sessionId) return previous
    const block = state().pendingQuestion
    return block === undefined ? undefined : { sessionId, block }
  })
  const dockedQuestions = () => {
    const pending = pendingQuestion()
    return pending === undefined ? [] : [pending]
  }

  // The composer floats over the pane, so the pane learns its height from it:
  // the transcript keeps that much room below the newest output, a landing
  // centers its row above it, and the jump control sits just above it. The
  // field grows with its text and a docked question can be any height.
  let footer: HTMLElement | undefined
  onMount(() => {
    if (footer) onCleanup(publishPaneHeight(footer, "--fw-composer-height"))
  })

  return (
    <footer class="composer" ref={(el) => (footer = el)}>
      {attachMenu.view()}
      {mention.view()}
      {panel.view()}
      <Key each={dockedQuestions()} by={(question) => `${question.sessionId}\u0000${question.block.toolUseId}`}>
        {(question) => <QuestionPanel block={() => question().block} sessionId={() => question().sessionId} interactions={questionInteractions} current={() => state().windowCurrent} hidden={panel.open} expand={questionAttention.request} />}
      </Key>

      <div
        class="composer-field"
        style={{ display: subagentFinished() ? "none" : undefined }}
        classList={{ dropping: dropping() }}
        // Keep the textarea's focus and keyboard while tapping its actions.
        onPointerDown={(event) => { if (event.target.closest("button")) event.preventDefault() }}
        onMouseDown={(event) => { if (event.target.closest("button")) event.preventDefault() }}
        // A drag carries no file list until it drops, only the fact that it
        // holds files; that is enough to light the card.
        onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDropping(true) } }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false)
          const files = transferredFiles(event.dataTransfer)
          if (files.length === 0) return
          event.preventDefault()
          addFiles(files)
        }}
      >
        <Show when={attachments.items().length > 0}>
          <div class="composer-attachments" role="list" aria-label="Attachments">
            <For each={attachments.items()}>
              {(item) => (
                <div class="attachment-chip" role="listitem" title={`${item.name ?? item.marker} · ${formatBytes(item.bytes)}`}>
                  <Show when={item.preview} fallback={<span class="attachment-file"><Icon path={ICONS.file} /></span>}>
                    {(preview) => <img class="attachment-thumb" src={preview()} alt="" />}
                  </Show>
                  <span class="attachment-name">{item.name ?? item.marker}</span>
                  <button data-input-focus={focusKey("remove", item.marker)} class="attachment-remove" type="button" title="Remove" aria-label={`Remove ${item.name ?? item.marker}`} onClick={() => attachments.remove(item.marker)}>
                    <Icon path={ICONS.close} size={12} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        {/* The chooser itself. No accept list: the person may pick anything,
            and a file Flywheel cannot carry is refused with the reason. */}
        <input
          ref={(el) => (fileInput = el)}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ""
            addFiles(files)
          }}
        />
        <textarea
          data-input-focus={focusKey("text")}
          ref={(el) => (composer = el)}
          // One row, because the grow effect measures with height:auto and a
          // taller rows value becomes the floor scrollHeight can never report
          // below: the box would jump to that height on the first character
          // and refuse to contract past it.
          rows="1"
          placeholder={composerPlaceholder()}
          value={draft()}
          autocapitalize="sentences"
          enterkeyhint="send"
          disabled={!editable()}
          onInput={(event) => {
            setDraft(event.currentTarget.value)
            setCaret(event.currentTarget.selectionStart)
            grow(event.currentTarget)
            // Editing is leaving history. Without this, ArrowUp after typing
            // would continue from an index that no longer describes what is
            // in the box.
            if (historyIndex() !== -1) setHistoryIndex(-1)
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={(event) => {
            const files = transferredFiles(event.clipboardData)
            if (files.length === 0) return
            event.preventDefault()
            addFiles(files)
          }}
        />
        <div class="composer-actions">
          <Show when={!child()}>
            <button
              class="composer-slash"
              data-input-focus={focusKey("commands")}
              title="Settings and commands"
              aria-label="Commands"
              // Typed rather than opened as a menu: the list is the composer's
              // own typeahead, so this puts the user in it rather than building a
              // second way to pick the same thing.
              onClick={() => { setDraft("/"); composer?.focus() }}
            >
              /
            </button>
          {/* The ways to put something other than typed words into the message:
              files or photos from this device, or a project file's path. Commands
              stay with the slash button beside it, which acts rather than adds. */}
          <button
            class="composer-attach"
            data-input-focus={focusKey("attach")}
            title="Attach files, or mention a project file"
            aria-label="Add to message"
            aria-haspopup="menu"
            aria-expanded={attachMenu.open()}
            ref={(el) => attachMenu.attachAnchor(el)}
            onClick={() => attachMenu.toggle()}
          >
            <Icon path={ICONS.plus} />
          </button>
          </Show>
          {/* The seat in use, always in view the way the terminal's prompt
              frame shows it: the running agent's model during a workflow, the
              chat's otherwise. Tapping it opens the model sheet. */}
          <Show when={displayedModel()}>
            {(model) => (
              <button data-input-focus={focusKey("model")} class="composer-model" title={`${model().model} at ${model().effort} effort. Change the model.`} aria-haspopup="dialog" aria-label={`Model: ${model().model}, ${model().effort} effort`} onClick={() => client.openSheet("model")}>
                <span class="composer-model-name">{model().model}</span>
                <span class="composer-model-effort">{model().effort}</span>
                <Icon path={ICONS.chevronDown} size={12} />
              </button>
            )}
          </Show>
          {/* The one entry point to the session's cumulative diff. The review is
              the client's own sheet, so it opens the same way on every host;
              a host with an editor offers to open it there from inside. */}
          <Show when={state().sessionId !== undefined && (changedCount() ?? 0) > 0}>
            <button
              class="composer-changes"
              data-input-focus={focusKey("changes")}
              title="Review session changes, retained evidence, and Undo"
              aria-label={`Show all changes: ${changedFiles()}`}
              onClick={() => client.openSheet("changes")}
            >
              <span class="composer-changes-label" aria-hidden="true">{changedFiles()}</span>
              <span class="composer-changes-compact" aria-hidden="true">
                <Icon path={ICONS.file} />
                <span class="composer-changes-count">{changedCount()}</span>
              </span>
            </button>
          </Show>
          {/* One slot, the TUI's rule: Send whenever there is something to send,
              which during a turn queues it for the next tool boundary, and
              Interrupt only while the box is empty during a turn. Interrupting
              is how a queued message goes now instead of after the current
              tool call. Resume sits beside it while the session waits to
              continue. */}
          <Show when={!child()} fallback={
            <>
              <Show when={controls().message}>
                <button data-input-focus={focusKey("send")} class="composer-send" title={submissionHeld() ? "Waiting for the runtime and a connected provider. Your draft is kept." : `Message this ${selectedRow()?.kind}`} aria-label="Send message" aria-disabled={submissionHeld() || undefined} disabled={draft().trim().length === 0} onClick={submit}>
                  <Icon path={ICONS.arrowUp} size={16} />
                </button>
              </Show>
              {/* Interrupt keeps the child's work and Resume continues it
                  from there; Stop ends it for its parent and never resumes. */}
              <Show when={controls().interrupt}>
                <button data-input-focus={focusKey("interrupt")} class="composer-stop" title="Interrupt this agent. Its work so far is kept and it can resume." aria-label="Interrupt" aria-busy={working("interrupt")} onClick={interrupt}>
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <rect x="1" y="1" width="14" height="14" rx="2" />
                  </svg>
                </button>
              </Show>
              <Show when={controls().resume}>
                <button data-input-focus={focusKey("resume")} class="composer-stop" title="Resume this agent from where it stopped" aria-label="Resume" aria-busy={working("resume")} onClick={() => client.actions.resume()}>
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M3 1.5v13l11-6.5z" />
                  </svg>
                </button>
              </Show>
              <Show when={controls().stop}>
                <button data-input-focus={focusKey("stop")} class="composer-stop" title="Stop this run. It ends for its parent and cannot resume." aria-label="Stop" aria-busy={working("stop")} onClick={() => { const sessionId = state().sessionId; if (sessionId !== undefined) client.actions.stop(sessionId) }}>
                  <Icon path={ICONS.stop} size={16} />
                </button>
              </Show>
            </>
          }>
            <Show when={controls().resume}>
              <button data-input-focus={focusKey("resume")} class="composer-stop" title="Resume from where it stopped, with no new message" aria-label="Resume" aria-busy={working("resume")} onClick={() => client.actions.resume()}>
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M3 1.5v13l11-6.5z" />
                </svg>
              </button>
            </Show>
            <Show
              when={controls().interrupt && draft().trim().length === 0 && attachments.items().length === 0}
              fallback={
                <button
                  class="composer-send"
                  data-input-focus={focusKey("send")}
                  title={submissionHeld() ? "Waiting for the runtime and a connected provider. Your draft is kept." : state().busy ? "Queue for the next tool call. Interrupt the turn to send it now." : "Send"}
                  aria-label={state().busy ? "Queue message" : "Send"}
                  aria-disabled={submissionHeld() || undefined}
                  aria-busy={startedRunning() !== undefined || undefined}
                  disabled={draft().trim().length === 0 && attachments.items().length === 0}
                  onClick={submit}
                >
                  <Icon path={ICONS.arrowUp} size={16} />
                </button>
              }
            >
              <button data-input-focus={focusKey("interrupt")} class="composer-stop" title="Interrupt the turn. Its work so far is kept and it can resume." aria-label="Interrupt" aria-busy={working("interrupt")} onClick={interrupt}>
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="1" y="1" width="14" height="14" rx="2" />
                </svg>
              </button>
            </Show>
          </Show>
        </div>
      </div>
      <Show when={subagentFinished()}><p class="composer-finished-notice">This subagent finished. Unread messages stay in the parent chat and return to the sending window's composer while it is open.</p></Show>
    </footer>
  )
}
