/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable, TextRenderable } from "@opentui/core"
import { StyledText, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useKeymap } from "@tui/context/keymap"
import { useTickPool } from "@tui/context/tick-pool-context"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { normalizeChatInput, type ChatInput, type ChatInputLike } from "../../infra/chat-input.js"
import { base64ByteLength } from "../../protocol/client/attachments.js"
import { createComposerFocus } from "../hooks/create-composer-focus.js"
import { createComposerQuestionHandoff } from "../hooks/create-composer-question-handoff.js"
import { createSpinnerStatus, spinnerAnimates } from "../hooks/create-spinner-status.js"
import { createGhostText } from "../hooks/create-ghost-text.js"
import { createMentionSuggestions } from "../hooks/create-mention-suggestions.js"
import { createSlashSuggestions } from "../hooks/create-slash-suggestions.js"
import { createComposerHistoryPopup } from "../hooks/create-composer-history-popup.js"
import { classifyComposerPopupKey } from "../hooks/create-composer-popup-key-slot.js"
import { createPasteBurstController } from "../hooks/paste-burst.js"
import { createPasteCollapse } from "../hooks/paste-collapse.js"
import { createPromptAttachments } from "../hooks/composer-attachments.js"
import { createLiveRenderableRef } from "../hooks/create-live-renderable-ref.js"
import { UNBOUND_COMPOSER_DRAFT, type ComposerDraftPaste } from "../hooks/create-draft-cache.js"
import { adoptDraftAttachments, mergeInputIntoDraft, replaceDraftMarker } from "../hooks/composer-draft-merge.js"
import { normalizedPrintableText } from "../keymap/text-entry.js"
import { QuestionDock } from "../question-dock.js"
import { ComposerBody, ComposerFrame, composerBodyGeometry, PROMPT_LEFT_INSET } from "./composer-frame.js"
import { SlashSuggestions } from "./slash-suggestions.js"
import { ComposerHistoryPopup } from "./composer-history-popup.js"
import { PROMPT_POPUP_MAX_VISIBLE_ROWS } from "./composer-popup-list.js"
import { createPromptBorderChunks } from "./composer-border-labels.js"
import type { ComposerProps } from "./composer-types.js"
import { recallOnUp } from "./composer-recall.js"



export function Composer(props: ComposerProps) {
  const themeCtx = useTheme()
  const { keymap } = useKeymap()
  const { theme } = themeCtx

  const [promptHeight, setComposerHeight] = createSignal(1)
  // The lifecycle-bound ref is the imperative OpenTUI state; inputText is its
  // reactive projection, synced only in widget callbacks.
  const [inputText, setInputText] = createSignal("")
  const [cursorOffset, setCursorOffset] = createSignal(0)
  const [cursorRow, setCursorRow] = createSignal(0)
  const [cursorCol, setCursorCol] = createSignal(0)
  const promptRef = createLiveRenderableRef<TextareaRenderable>()
  let pasteCollapse: ReturnType<typeof createPasteCollapse> | null = null
  // Advances on every buffer replacement, user edit, submit clear, and draft
  // load, so an asynchronous recall can tell whether it still owns the buffer
  // it read from.
  let promptRevision = 0
  let pendingSubmit = 0
  // The tab whose draft the prompt buffer currently displays. The foreground
  // switch effect may run before or after handleSubmit resumes, so submit
  // decides whether to clear the buffer from this ownership record, not from
  // signal timing.
  const draftOwnerId = () => props.foregroundId() ?? UNBOUND_COMPOSER_DRAFT
  let bufferOwnerId = untrack(draftOwnerId)
  const promptAttachments = createPromptAttachments(
    () => themeCtx.syntax,
    draftOwnerId,
    untrack(() => props.clipboard),
    {
      onChange: syncComposerText,
      onReady: () => {
        persistCurrentDraft()
        promptAttachments.syncExtmarks()
      },
      report: (message) => props.onAttachmentWarning(message),
      displayedOwner: () => bufferOwnerId,
      backgroundBytes: (owner) => props.draftCache.get(owner).attachments.reduce((sum, item) => sum + base64ByteLength(item.data), 0),
      onBackgroundSettled: (owner, marker, result) => {
        const draft = props.draftCache.get(owner)
        if (!draft.text.includes(marker)) return
        props.draftCache.set(owner, typeof result === "string"
          ? replaceDraftMarker(draft, marker, result)
          : { ...draft, attachments: [...draft.attachments, result] })
      },
    },
  )
  const pasteBurst = createPasteBurstController({
    insertTyped(text) {
      const prompt = promptRef.current()
      if (!prompt) return
      prompt.insertText(text)
      syncComposerText()
    },
    applyPaste,
    onPendingStart: () => { promptRevision += 1 },
    textBeforeCursor() {
      const prompt = promptRef.current()
      if (!prompt) return ""
      return (prompt.plainText ?? "").slice(0, prompt.editBuffer.getCursorPosition().offset)
    },
    retractBeforeCursor(start, end) {
      const prompt = promptRef.current()
      if (!prompt) return
      const coordinates = (offset: number) => {
        const lines = (prompt.plainText ?? "").slice(0, offset).split("\n")
        return { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 }
      }
      const from = coordinates(start)
      const to = coordinates(end)
      prompt.deleteRange(from.line, from.column, to.line, to.column)
    },
  })
  onCleanup(() => {
    pasteBurst.flushBeforeModifiedInput()
    if (promptRef.current()) props.draftCache.set(bufferOwnerId, currentDraft())
    pasteBurst.dispose()
  })
  let programmaticEdit = false
  // A pending question owns the keys. The prompt stays on screen until the
  // dock has measured itself, but it must not take a key in that frame.
  const attachComposerFocus = createComposerFocus(() => props.captureFocus() && !pendingQuestionOwner(), () => props.foregroundId())

  const rankedNames = createMemo(() => {
    const names = props.completableNames()
    const frequency = props.commandFrequency()
    return names.slice().sort((a, b) => (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0))
  })
  const textBeforeCursor = createMemo(() => inputText().slice(0, cursorOffset()))
  const completableNameSet = createMemo(() => new Set(props.completableNames().map(n => n.toLowerCase())))
  const dispatchableNameSet = createMemo(() => new Set(props.dispatchableNames().map(n => n.toLowerCase())))
  const suggestions = createSlashSuggestions({
    textBeforeCursor,
    inputText,
    catalog: () => props.slashCatalog,
    frequency: () => props.commandFrequency(),
    dispatchableTokens: dispatchableNameSet,
  })
  const mentions = createMentionSuggestions({
    textBeforeCursor,
    inputText,
    cursorOffset,
    projectFiles: (query) => props.projectFiles(query),
  })
  // The slash popup and the @ picker are the same kind of thing to the keys
  // and the frame: whichever is open is the popup. A leading slash token
  // wins, since it owns the whole input.
  const popup = () => suggestions.visible() ? suggestions : mentions.visible() ? mentions : undefined
  const historyPopup = createComposerHistoryPopup({ entries: () => props.history.entries() })
  const rawGhostText = createGhostText(() => textBeforeCursor(), () => rankedNames())
  // A popup replaces the inline ghost hint while open. Escape cancels the
  // completion too, so the hint stays hidden until the token changes.
  const ghostText = createMemo(() => (popup() !== undefined || historyPopup.visible() || suggestions.dismissedHere() ? "" : rawGhostText()))
  // While a popup is open, escape must dismiss it (not interrupt the agent),
  // plain tab must complete (not cycle sessions), and the history popup's
  // navigation/activation keys must stay local: claim exactly the keys the
  // popup key handlers act on; the acting branches live in handleKeyDown.
  // Slash ownership wins: any leading slash token routes keys to the slash
  // popup even when the history popup would otherwise claim them.
  onMount(() => {
    // eslint-disable-next-line solid/reactivity -- register stores this keyboard event handler; its reactive reads must happen when the key arrives
    props.promptPopupKeySlot.register((key) => {
      if (props.pendingQuestion()) return false
      if (popup() !== undefined) return classifyComposerPopupKey(key, { acceptsTab: true }) !== undefined
      return historyPopup.visible() && classifyComposerPopupKey(key, { acceptsTab: false }) !== undefined
    })
  })

  const commandSpans = createMemo((): { start: number; end: number }[] => {
    const text = inputText()
    if (!text.includes("/")) return []
    const names = completableNameSet()
    const spans: { start: number; end: number }[] = []
    // Match the leading whitespace/start as a non-captured boundary, then a
    // single capture for the command token. The whole match starts at the
    // boundary; the command starts at the "/" inside it, so cmdStart is the
    // match index plus the offset of "/" within match[0].
    const re = /(?:^|[\s])(\/[a-zA-Z][\w-]*(?::[\w-]*)?)/g
    for (const match of text.matchAll(re)) {
      const whole = match[0]
      const slash = whole.indexOf("/")
      const cmdText = whole.slice(slash)
      const cmdStart = match.index + slash
      const cmdName = cmdText.slice(1).toLowerCase()
      if (names.has(cmdName)) spans.push({ start: cmdStart, end: cmdStart + cmdText.length })
    }
    return spans
  })
  let commandTypeId: number | undefined

  function syncCommandExtmarks(): void {
    const prompt = promptRef.current()
    if (!prompt || commandTypeId === undefined) return
    for (const extmark of prompt.extmarks.getAllForTypeId(commandTypeId)) {
      prompt.extmarks.delete(extmark.id)
    }
    const styleId = themeCtx.syntax.resolveStyleId("prompt")
    if (styleId === null) return
    for (const span of commandSpans()) {
      prompt.extmarks.create({ start: span.start, end: span.end, styleId, typeId: commandTypeId })
    }
  }

  function replaceContent(text: string, options: { persist?: boolean } = {}): void {
    const prompt = promptRef.current()
    if (!prompt) return
    promptRevision += 1
    promptAttachments.invalidateClaims()
    runProgrammaticEdit(() => {
      prompt.clear()
      pasteCollapse?.restore([])
      if (text) prompt.insertText(text)
      setInputText(text)
    })
    recalcComposerHeight()
    if (options.persist ?? true) persistCurrentDraft()
  }

  function restoreInput(input: ChatInputLike): void {
    const normalized = normalizeChatInput(input)
    promptAttachments.clear()
    replaceContent(normalized.text, { persist: false })
    promptAttachments.restore(normalized.attachments ?? [])
    persistCurrentDraft()
  }

  function syncComposerText(): void {
    promptAttachments.reconcilePendingMarkers()
    // Ordinary editing dismisses the history browser; it never edits back.
    historyPopup.close()
    promptRevision += 1
    setInputText(promptRef.current()?.plainText ?? "")
    persistCurrentDraft()
    promptAttachments.syncExtmarks()
    recalcComposerHeight()
  }

  function applyPaste(text: string): void {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    const insert = (ordinaryText: string) => {
      pasteCollapse?.applyPaste(ordinaryText)
      syncComposerText()
    }
    if (!promptAttachments.claimPasteText(normalized)) insert(normalized)
  }

  function textWithPendingPaste(text: string, cursor = promptRef.current()?.editBuffer.getCursorPosition().offset ?? text.length): string {
    const pending = pasteBurst.snapshot()
    if (!pending) return text
    return text.slice(0, cursor) + pending + text.slice(cursor)
  }

  function currentDraft(text = promptRef.current()?.plainText ?? "", cursor?: number) {
    const completeText = textWithPendingPaste(text, cursor)
    const pendingLength = completeText.length - text.length
    const insertionOffset = cursor ?? promptRef.current()?.editBuffer.getCursorPosition().offset ?? text.length
    return {
      text: completeText,
      pastes: currentDraftPastes().map((paste) => paste.start >= insertionOffset
        ? { ...paste, start: paste.start + pendingLength, end: paste.end + pendingLength }
        : paste),
      attachments: promptAttachments.serialize(completeText),
      caret: insertionOffset + pendingLength,
    }
  }

  function persistCurrentDraft(): void {
    if (!programmaticEdit) props.draftCache.set(draftOwnerId(), currentDraft())
  }
  function currentDraftPastes(): readonly ComposerDraftPaste[] { return pasteCollapse?.serialize() ?? [] }

  function runProgrammaticEdit(edit: () => void): void {
    programmaticEdit = true
    try {
      edit()
    } finally {
      programmaticEdit = false
    }
  }

  function recalcComposerHeight(): void {
    const prompt = promptRef.current()
    if (!prompt) { setComposerHeight(1); return }
    setComposerHeight(Math.max(1, prompt.editorView.getTotalVirtualLineCount()))
  }

  function loadDraftIntoPrompt(fgId: string): void {
    const prompt = promptRef.current()
    if (!prompt) return
    promptRevision += 1
    const draft = props.draftCache.get(fgId)
    runProgrammaticEdit(() => {
      pasteBurst.clear()
      prompt.clear()
      if (draft.text) prompt.insertText(draft.text)
      pasteCollapse?.restore(draft.pastes)
      promptAttachments.restore(draft.attachments)
      if (draft.caret !== undefined) prompt.cursorOffset = draft.caret
      setInputText(prompt.plainText ?? "")
    })
    recalcComposerHeight()
  }

  onMount(() => props.ref?.({
    persistDraft: persistCurrentDraft,
    appendInput: (sessionId, input) => mergeIntoDraft(input, sessionId),
    adoptDraft(pendingKey, sessionId) {
      if (promptRef.current() && (bufferOwnerId === pendingKey || bufferOwnerId === sessionId)) {
        pasteBurst.flushBeforeModifiedInput()
        props.draftCache.set(bufferOwnerId, currentDraft())
      }
      adoptDraftAttachments(props.draftCache, pendingKey, sessionId, promptAttachments.adoptPending)
      if (bufferOwnerId === pendingKey || bufferOwnerId === sessionId) {
        bufferOwnerId = sessionId
        loadDraftIntoPrompt(sessionId)
      }
    },
  }))

  createEffect(on(() => props.lineWidth(), () => {
    queueMicrotask(recalcComposerHeight)
  }))

  const pendingQuestionOwner = createComposerQuestionHandoff({
    foregroundId: () => props.foregroundId(),
    pendingQuestion: () => props.pendingQuestion(),
    // eslint-disable-next-line solid/reactivity -- the draft cache is one object for the composer's lifetime
    draftCache: props.draftCache,
    onDock: () => { pasteBurst.flushBeforeModifiedInput(); persistCurrentDraft() },
    onDraftMoved: loadDraftIntoPrompt,
  })

  createEffect(on(draftOwnerId, (fgId) => {
    const prompt = promptRef.current()
    if (prompt) props.draftCache.set(bufferOwnerId, currentDraft(prompt.plainText ?? ""))
    if (bufferOwnerId === UNBOUND_COMPOSER_DRAFT && fgId !== UNBOUND_COMPOSER_DRAFT && !props.draftCache.hasDraft(fgId)) {
      adoptDraftAttachments(props.draftCache, UNBOUND_COMPOSER_DRAFT, fgId, promptAttachments.adoptPending)
    }
    loadDraftIntoPrompt(fgId)
    bufferOwnerId = fgId
    historyPopup.close()
  }, { defer: true }))

  function submitPrepared(v: string, submission: ChatInput, originFgId: string): void {
    // A command may switch the foreground synchronously (e.g. /clear opens a
    // fresh tab); the switch effect persists the submitted text into the
    // origin tab's draft, so clear the origin's draft, not the new one's.
    // eslint-disable-next-line solid/reactivity -- boundary: submit runs both callbacks synchronously inside this key handler
    promptAttachments.submit(() => props.onSubmit(submission), (result) => {
      if (!result) return
      if (result !== true) void result.accepted.then((accepted) => untrack(() => { if (!accepted) mergeIntoDraft(submission, originFgId) }))
      props.history.add(v)
      props.draftCache.clear(originFgId)
      // Clear the buffer only while it still shows the submitted text. After a
      // foreground switch's effect has run, the buffer holds the new tab's
      // draft; clearing it then would wipe that draft. If the switch effect has
      // not run yet, it will persist the buffer we clear here, which correctly
      // leaves the origin tab without a draft.
      if (bufferOwnerId !== originFgId) return
      promptRevision += 1
      runProgrammaticEdit(() => {
        promptRef.current()?.clear()
        promptAttachments.clear()
        setInputText("")
      })
      setComposerHeight(1)
    })
  }

  function handleSubmit(): void {
    pasteBurst.flushBeforeModifiedInput()
    const visible = promptRef.current()?.plainText ?? ""
    const v = pasteCollapse?.expandForSubmit() ?? promptRef.current()?.plainText ?? ""
    const originFgId = draftOwnerId()
    if (promptAttachments.hasPending(v, originFgId)) {
      const revision = promptRevision
      const request = ++pendingSubmit
      void promptAttachments.prepareSubmission(v, originFgId).then((submission) => untrack(() => {
        if (request !== pendingSubmit || !submission || draftOwnerId() !== originFgId || bufferOwnerId !== originFgId) return
        if (promptRevision !== revision || promptRef.current()?.plainText !== visible) {
          props.onAttachmentWarning("The message changed while an image was loading. Press Enter to send.")
          return
        }
        pendingSubmit += 1
        promptAttachments.invalidateClaims()
        submitPrepared(v, submission, originFgId)
      }))
      return
    }
    pendingSubmit += 1
    promptAttachments.invalidateClaims()
    submitPrepared(v, promptAttachments.toSubmission(v), originFgId)
  }

  /** Recall resolves asynchronously; when nothing was queued, fall through to
   *  the history popup so Up on an empty prompt always browses history.
   *
   *  Recall is destructive at the runtime, so a settlement that no longer owns
   *  the buffer must not drop the message: it merges into the draft of the
   *  session it came from, and reloads that draft only if it is still live. */
  async function restoreRecalledInput(
    recalled: ChatInputLike | null | Promise<ChatInputLike | null>,
    originSessionId: string,
    originRevision: number,
  ): Promise<void> {
    const input = await recalled
    const stillOwns = draftOwnerId() === originSessionId && promptRevision === originRevision
    if (!input) {
      if (stillOwns && (promptRef.current()?.plainText ?? "").length === 0) historyPopup.open()
      return
    }
    if (stillOwns) { restoreInput(input); return }
    mergeIntoDraft(input, originSessionId)
  }

  /** Returns input that left the prompt to the draft of the session it came
   *  from, after anything typed there since, and shows it if that draft is live. */
  function mergeIntoDraft(input: ChatInputLike, originSessionId: string): void {
    if (draftOwnerId() === originSessionId) pasteBurst.flushBeforeModifiedInput()
    mergeInputIntoDraft(props.draftCache, originSessionId, input)
    if (draftOwnerId() === originSessionId) loadDraftIntoPrompt(originSessionId)
  }

  function handleHistoryUp(key: { preventDefault?: () => void }): void {
    const prompt = promptRef.current()
    if (!prompt) return
    recallOnUp({
      ready: true, row: prompt.editorView.getCursor().row, text: prompt.plainText ?? "",
      active: props.agentState() === "active", preventDefault: () => key.preventDefault?.(),
      local: props.onRecallLocal, queued: props.onRecallQueued, restore: restoreInput,
      settle: (recalled) => { void restoreRecalledInput(recalled, draftOwnerId(), promptRevision) },
      history: () => historyPopup.open(),
    })
  }

  /** Non-destructive activation: the selected entry's original exact text is
   *  inserted (replacing and persisting the draft) but never submitted. The
   *  single path for both Enter and row clicks. */
  function activateHistoryEntry(index: number): void {
    const entry = historyPopup.rows()[index]
    historyPopup.close()
    if (entry !== undefined) replaceContent(entry)
  }

  /** History popup browsing is non-destructive: opening, moving, Escape, and
   *  Down past the newest (bottom) row never touch the prompt input. Closing
   *  past the newest row is a keyboard-only affordance; the wheel clamps. */
  function handleHistoryPopupKey(key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault?: () => void }): boolean {
    if (!historyPopup.visible()) return false
    switch (classifyComposerPopupKey(key, { acceptsTab: false })) {
      case "up": historyPopup.moveSelection(-1); break
      case "down":
        if (historyPopup.selectedIndex() === historyPopup.rows().length - 1) historyPopup.close()
        else historyPopup.moveSelection(1)
        break
      case "return": activateHistoryEntry(historyPopup.selectedIndex()); break
      case "escape": historyPopup.close(); break
      default: return false
    }
    key.preventDefault?.()
    return true
  }

  function handleGhostAccept(key: { preventDefault?: () => void }): void {
    const prompt = promptRef.current()
    if (!prompt) return
    const gt = ghostText()
    if (!gt) return
    promptRevision += 1
    prompt.insertText(gt)
    setInputText(prompt.plainText ?? "")
    persistCurrentDraft()
    recalcComposerHeight()
    key.preventDefault?.()
  }

  function acceptSuggestion(submit: boolean): void {
    const active = popup()
    const text = active?.completedText()
    if (text === undefined) return
    replaceContent(text)
    // A picked command is a message ready to go; a picked file is a word in
    // one still being written.
    if (submit && active === suggestions) handleSubmit()
  }

  function handleSuggestionKey(key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault?: () => void }): boolean {
    const active = popup()
    if (active === undefined) return false
    switch (classifyComposerPopupKey(key, { acceptsTab: true })) {
      case "up": active.moveSelection(-1); break
      case "down": active.moveSelection(1); break
      case "tab": acceptSuggestion(false); break
      case "return": acceptSuggestion(true); break
      case "escape": active.dismiss(); break
      default: return false
    }
    key.preventDefault?.()
    return true
  }

  function handleKeyDown(key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; super?: boolean; preventDefault?: () => void }): void {
    const prompt = promptRef.current()
    if (!prompt) return
    const now = Date.now()
    const printable = key.super ? null : normalizedPrintableText(key)
    if (printable !== null) {
      key.preventDefault?.()
      pasteBurst.onCharacter(printable, now)
      return
    }
    const plain = !key.ctrl && !key.meta && !key.super
    if (plain && (key.name === "return" || key.name === "tab")) {
      const control = key.name === "return" ? "\n" : "\t"
      if (pasteBurst.onControl(control, now)) {
        key.preventDefault?.()
        return
      }
      if (key.name === "return" && pasteBurst.newlineShouldInsert(now)) {
        key.preventDefault?.()
        prompt.insertText("\n")
        syncComposerText()
        return
      }
    }
    pasteBurst.flushBeforeModifiedInput()
    if (handleSuggestionKey(key)) return
    if (handleHistoryPopupKey(key)) return
    if (key.name === "v" && (key.ctrl || key.super)) {
      key.preventDefault?.()
      const owner = draftOwnerId()
      void promptAttachments.pasteFromClipboard(owner).then((pasted) => { if (pasted) syncComposerText() })
      return
    }
    if (key.name === "up") { handleHistoryUp(key); return }
    if (key.name === "right" && !key.ctrl && !key.meta && !key.shift) handleGhostAccept(key)
  }

  const placeholder = createMemo(() => {
    const active = props.agentState() === "active"
    const text = props.inChat()
      ? active
        ? "Send a message to the running turn"
        : `Send a message (${keymap.chordFor("new")} for fresh chat)`
      : "Send a message..."
    return props.interruptible() ? `${text} · esc to interrupt` : text
  })

  const ghostContent = createMemo(() => {
    const gt = ghostText()
    if (!gt) return null
    return new StyledText([stFg(theme.textMuted)(gt)])
  })

  const geometry = createMemo(() => composerBodyGeometry(props.lineWidth(), promptHeight()))
  const promptBodyWidth = () => geometry().width
  const promptBodyHeight = () => geometry().height
  const promptTopOffset = () => geometry().top
  const popupHeight = createMemo(() => {
    const active = popup()
    if (active !== undefined) return Math.min(active.matches().length, PROMPT_POPUP_MAX_VISIBLE_ROWS)
    if (historyPopup.visible()) return Math.min(historyPopup.rows().length, PROMPT_POPUP_MAX_VISIBLE_ROWS)
    return 0
  })
  // The composer owns its status line's fold, so no visibility gate can come
  // between them: the frame stays on screen under an overlay, such as a child
  // viewer, and must show the foreground session's current state there.
  const spinnerSource = untrack(() => props.spinnerSource)
  const spinnerTick = useTickPool().createSharedTick(50, () => spinnerAnimates(spinnerSource))
  const { status: spinnerStatus } = createSpinnerStatus({ source: spinnerSource, terminalWidth: () => Math.max(20, props.lineWidth() - 4), tick: spinnerTick })
  const borderChunks = createPromptBorderChunks({
    theme,
    layout: () => props.promptBorderLayout(),
    lineWidth: () => props.lineWidth(),
    status: spinnerStatus,
    idle: () => props.agentState() === "idle",
  })
  // The prompt stays until the dock has measured itself, so the prompt area
  // swaps from the prompt to the dock in one frame and is never empty.
  const [dockMeasured, setDockMeasured] = createSignal(false)
  return (
    <box flexDirection="column" flexShrink={1} minHeight={0}>
      <Show when={!(pendingQuestionOwner() && dockMeasured())}>
        <box flexDirection="column" paddingBottom={1} selectable={false}>
          <ComposerFrame
            theme={theme}
            width={props.lineWidth()}
            bodyHeight={promptBodyHeight()}
            onMouseDown={() => promptRef.current()?.focus?.()}
            topRightChunks={borderChunks.topRightChunks}
            bottomLeftChunks={borderChunks.bottomLeftChunks}
            bottomRightChunks={borderChunks.bottomRightChunks}
            controls={borderChunks.controls}
            onModuleAction={props.onModuleAction}
            actions={{
              update: props.onDismissUpdate,
              changes: props.onOpenChanges,
              sessions: props.onOpenSessions,
              model: props.onOpenModel,
              new: props.onNew,
              close: props.onClose,
              switch: props.onNextTab,
              background: props.onOpenBackground,
              resume: props.onResume,
            }}
            popupHeight={popupHeight()}
            popup={
              // Indented by the input's left inset so the option slashes align
              // with the typed slash below the divider.
              <box paddingLeft={PROMPT_LEFT_INSET}>
                <Show when={popup()} fallback={
                  <ComposerHistoryPopup
                    history={historyPopup}
                    width={() => Math.max(0, promptBodyWidth() - PROMPT_LEFT_INSET)}
                    onActivate={activateHistoryEntry}
                  />
                }>
                  {(active) => (
                    <SlashSuggestions
                      suggestions={active()}
                      width={() => Math.max(0, promptBodyWidth() - PROMPT_LEFT_INSET)}
                      onActivate={(index) => { active().select(index); acceptSuggestion(true) }}
                    />
                  )}
                </Show>
              </box>
            }
          >
            <ComposerBody theme={theme} width={props.lineWidth()} lines={promptHeight()} text={inputText()} placeholder={placeholder()} onSubmit={handleSubmit}
                attach={(r: TextareaRenderable) => {
                  promptRef.attach(r)
                  const pc = createPasteCollapse(r, () => themeCtx.syntax)
                  pasteCollapse = pc
                  promptAttachments.attach(r)
                  // `/attach` lands here: the picked files become markers in this
                  // textarea, the same way a pasted image does.
                  props.promptAttachSlot.register(promptAttachments.captureAppender)
                  commandTypeId = r.extmarks.registerType("command")
                  createEffect(() => {
                    r.syntaxStyle = themeCtx.syntax
                    syncCommandExtmarks()
                    promptAttachments.syncExtmarks()
                  })
                  r.onPaste = (event) => {
                    pasteBurst.flushBeforeModifiedInput()
                    if (event.metadata?.mimeType?.startsWith("image/") && promptAttachments.handlePaste(event)) {
                      syncComposerText()
                      return
                    }
                    event.preventDefault()
                    applyPaste(new TextDecoder().decode(event.bytes))
                  }
                  r.onContentChange = () => {
                    if (programmaticEdit) return
                    syncComposerText()
                  }
                  r.onKeyDown = handleKeyDown
                  r.onCursorChange = (ev) => {
                    setCursorOffset(r.cursorOffset)
                    setCursorRow(ev.line)
                    setCursorCol(ev.visualColumn)
                  }
                  loadDraftIntoPrompt(draftOwnerId())
                  attachComposerFocus(r)
                }}
              >
              <Show when={ghostContent()}>
                <text
                  ref={(el: TextRenderable) => {
                    createEffect(() => { el.content = ghostContent() ?? new StyledText([]) })
                  }}
                  selectable={false}
                  position="absolute" top={cursorRow() + promptTopOffset()} left={cursorCol() + PROMPT_LEFT_INSET}
                  overflow="hidden" wrapMode="none"
                />
              </Show>
            </ComposerBody>
          </ComposerFrame>
        </box>
      </Show>
      <Show when={pendingQuestionOwner()}>
        {(pq) => (
          <QuestionDock
            sessionId={pq().sessionId}
            question={pq().question}
            draftCache={props.draftCache}
            width={props.lineWidth()}
            onAnswer={(answers) => props.onAnswerQuestion(pq().question.toolUseId, answers)}
            onCancel={() => props.onCancelQuestion(pq().question.toolUseId)}
            captureFocus={props.captureFocus} onMeasured={setDockMeasured}
          />
        )}
      </Show>
    </box>
  )
}
