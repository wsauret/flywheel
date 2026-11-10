import { createEffect, createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"

import { ExtensionBlock, useClientExtensions } from "./client-extensions.js"
import { PROCESSOR_WAIT_NOTE, toolActivity, toolProcess, waitsForProcessor, type ProcessStatus } from "../../../src/protocol/client/transcript-model.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import { parseSessionLink } from "../../../src/protocol/client/session-links.js"
import { isReturnedInputNotice } from "../../../src/protocol/composer-returns.js"
import { actionKey } from "../client/action-key.js"
import type { FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../../../src/protocol/app-service-types.js"
import { totalDiffOmittedLines } from "../../../src/protocol/diff-omission.js"
import { conflictMarkersNotice, fileChangeDetail, isShellMutationEntry, notAppliedNotice, rowPresentation, rowWritePolicy, selectFileChangeBody, showsShellMutationOutput, type FileChangeBody } from "../../../src/protocol/client/file-change-body.js"
import type { WriteSyntaxThemeId } from "../../../src/protocol/write-syntax-theme.js"

import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import type { MutationEvidenceReader, MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import type { BlockDisclosure } from "./block-disclosure.js"
import { FileDiff } from "./file-diff.js"
import { questionRecordRows } from "../client/question-answer.js"
import { readRowPath } from "../../../src/protocol/client/tool-run-category.js"
import { toolRowDetail } from "./compact-tool-row.js"
import type { PresentedWebBlock } from "../client/tool-runs.js"
import { turnFoldSummary, type TurnFold } from "../client/turn-folds.js"
import type { SessionReadingSource } from "./session-reading.js"
import { renderCode, renderDiff } from "./markdown.js"
import { Markdown } from "./markdown-view.js"
import { UserMessage } from "./message.js"
import { formatClock } from "../client/format-time.js"
import { writeSyntaxPresentation } from "./write-syntax.js"
import "../styles/blocks.css"
import "../styles/markdown.css"
import "../styles/write-syntax.css"
import { messageDisclosureEntry } from "../../../src/protocol/client/message-sender.js"
import { AgentGroup } from "./agent-group.js"
import { BlockTime } from "./row-time.js"

/** One transcript block.
 *
 *  Everything here is a projection of what the runtime already decided. The
 *  view chooses presentation and disclosure; it never derives status, identity,
 *  or ordering, all of which arrive settled. */

type FrontendQuestionBlock = Extract<FrontendOutputBlock, { kind: "question" }>

interface ToolFileBodyMode {
  readonly bodyAvailable: boolean
  readonly advisory?: string
}

export function toolFileBodyMode(
  entry: FrontendToolEntry,
  body: FileChangeBody,
): ToolFileBodyMode {
  if (entry.fileChangeKind === undefined) return { bodyAvailable: true }
  if (body.kind === "actual" && body.mutationEvidence !== undefined) return { bodyAvailable: true }
  if (entry.status === "error") return { bodyAvailable: false }
  if (body.kind === "advisory") return { bodyAvailable: false, advisory: body.message }
  return { bodyAvailable: true }
}

export interface BlockProps {
  inlineTime?: boolean
  block: PresentedWebBlock
  sessionId: string
  disclosure: BlockDisclosure
  /** The full body, once fetched. Absent means the wire form is all we have. */
  body?: HydratedOutputBlockBody | undefined
  mutationEvidence?: MutationEvidenceReader | undefined
  /** Whether the host can open a path. Without it a diff is evidence to read,
   *  not a door into an editor, and it must not offer one. */
  canOpenFiles: boolean
  onOpenFile: (path: string, asDiff?: boolean) => void
  onHydrate: (blockId: string) => void
  /** Image decoding changes layout without a transcript mutation. */
  onImageLoad?: () => void
  onTerminateBackground: (toolUseId: string) => void
  onDetachBash: (toolUseId: string) => void
  /** Whether the action under an action key runs, for a tool's Stop and Detach. */
  working: (key: string) => boolean
  onHydrateGroup: (groupBlockId: string) => void
  /** Follows a link to another session, e.g. a workflow launched from this
   *  chat. `label` is the name the person tapped, which the destination shows
   *  until the session's own row names it, and `agentNodeId` the workflow
   *  agent the destination opens on, as a workflow card names it. */
  onSelectSession: (sessionId: string, label: string) => void
  initialMessageLabel?: string | undefined
  roleAssignments: SessionReadingSource<RoleAssignmentView>
  /** The status of a child that an agent group card shows. */
  statuses: SessionReadingSource<StatusView>
  /** The children fetched for this block, when it is an agent group. */
  group?: { readonly children: readonly FrontendToolEntry[]; readonly total: number } | undefined
  /** Live text for this block, when it is a tool that is still running. */
  streaming?: FrontendToolStreamingText | undefined
  processStatus?: ProcessStatus | undefined
  writeSyntaxTheme: WriteSyntaxThemeId
}

export function Block(props: BlockProps) {
  return <ExtensionBlock block={props} fallback={() => <OrdinaryBlock {...props} />} />
}

function OrdinaryBlock(props: BlockProps) {
  return (
    <div class="timed-block">
    <Show when={props.block.kind !== "agentGroup" && (props.block.kind === "userMessage" || props.block.kind === "text" || props.block.kind === "thinking" || (props.block.kind === "tool" && !props.inlineTime))}>
      <BlockTime block={props.block} processStatus={props.processStatus} />
    </Show>
    <Switch fallback={null}>
      <Match when={props.block.kind === "userMessage" && props.block.injected ? props.block : undefined}>
        {(block) => <InjectedMessage content={block().content} />}
      </Match>

      <Match when={props.block.kind === "userMessage" && props.block.from && props.block.from.relation !== "parent" ? { block: props.block, from: props.block.from } : undefined}>
        {(message) => <Tool entry={messageDisclosureEntry(message().block, message().from)} disclosureId={`userMessage:${message().block.id}`}
          sessionId={props.sessionId} disclosure={props.disclosure} body={props.body}
          canOpenFiles={props.canOpenFiles} onOpenFile={props.onOpenFile} onSelectSession={props.onSelectSession}
          onHydrate={props.onHydrate} onTerminateBackground={props.onTerminateBackground}
          onDetachBash={props.onDetachBash} working={props.working} writeSyntaxTheme={props.writeSyntaxTheme} />}
      </Match>

      <Match when={props.block.kind === "userMessage" ? props.block : undefined}>
        {(block) => (
          <UserMessage block={block()} body={props.body} onHydrate={props.onHydrate} onImageLoad={props.onImageLoad} sessionId={props.sessionId} disclosure={props.disclosure} initialMessageLabel={props.initialMessageLabel} />
        )}
      </Match>

      <Match when={props.block.kind === "text" ? props.block : undefined}>
        {(block) => (
          <div class="message">
            <Markdown class="block assistant" source={block().content} />
          </div>
        )}
      </Match>

      {/* A thought reaches here only while Show thinking is on; the transcript
          filters the rest. Providers often obfuscate the reasoning stream, so
          the row leads with its first line and opens to whatever arrived. */}
      <Match when={props.block.kind === "thinking" ? props.block : undefined}>
        {(block) => <Thought content={block().content} streaming={block().status === "streaming"} />}
      </Match>

      <Match when={props.block.kind === "tool" ? props.block : undefined}>
        {(block) => (
          <Tool
            meta={props.inlineTime ? <BlockTime block={props.block} processStatus={props.processStatus} inline /> : undefined}
            entry={block()}
            sessionId={props.sessionId}
            disclosure={props.disclosure}
            body={props.body}
            mutationEvidence={props.mutationEvidence}
            canOpenFiles={props.canOpenFiles}
            onOpenFile={props.onOpenFile}
            onSelectSession={props.onSelectSession}
            onHydrate={props.onHydrate}
            onTerminateBackground={props.onTerminateBackground}
            onDetachBash={props.onDetachBash}
            working={props.working}
            streaming={props.streaming}
            processStatus={props.processStatus}
            writeSyntaxTheme={props.writeSyntaxTheme}
          />
        )}
      </Match>

      <Match when={props.block.kind === "question" ? props.block : undefined}>
        {(block) => <QuestionRecord block={block()} />}
      </Match>

      <Match when={props.block.kind === "system" ? props.block : undefined}>
        {(block) => (
          <div class="block system" classList={{ error: block().level === "error", "returned-input": isReturnedInputNotice(block().id) }}>
            {block().message}
          </div>
        )}
      </Match>

      <Match when={props.block.kind === "divider" ? props.block : undefined}>
        {(block) => (
          <div class="divider">
            <span>{block().label}</span>
          </div>
        )}
      </Match>

      <Match when={props.block.kind === "agentGroup" ? props.block : undefined}>
        {(block) => (
          <AgentGroup
            block={block()}
            children={props.group}
            onSelectSession={props.onSelectSession}
            onTerminateBackground={props.onTerminateBackground}
            working={props.working}
            onHydrateGroup={props.onHydrateGroup}
            roleAssignments={props.roleAssignments}
            statuses={props.statuses}
            sessionId={props.sessionId}
            onOpenFile={props.canOpenFiles ? (path) => props.onOpenFile(path) : undefined}
          />
        )}
      </Match>

      <Match when={props.block.kind === "degraded"}>
        <div class="block system">Part of this transcript could not be displayed.</div>
      </Match>
    </Switch>
    </div>
  )
}

/** Reveals the work between the person's message and a settled final answer. */
export function TurnFoldBlock(props: { readonly fold: TurnFold; readonly metadata?: ReadonlyMap<string, MutationFilesView>; readonly onToggle: () => void }) {
  const work = createMemo(() => ({
    rows: props.fold.rows.filter(row => row.kind === "tool" || row.kind === "toolGroup" || row.kind === "agentGroup" || row.kind === "question"),
    duration: props.fold.duration,
  }), undefined, {
    equals: (previous, next) => previous.duration === next.duration && previous.rows.length === next.rows.length
      && previous.rows.every((row, index) => row === next.rows[index]),
  })
  const summary = createMemo(() => turnFoldSummary(work(), props.metadata))
  return (
    <button class="disclosure turn-fold" aria-expanded={props.fold.open} onClick={props.onToggle}>
      <span class="chevron">{props.fold.open ? "▾" : "▸"}</span>
      <span>
        {formatClock(props.fold.timestamp)}{" · "}{summary().label}
        <Show when={summary().failed > 0}>{" · "}<span class="tool-group-failed">{summary().failed} failed</span></Show>
      </span>
    </button>
  )
}

/** Reasoning is collapsed by default. It is evidence for a reader who wants it,
 *  not the answer, and expanded by default it buries the answer. */
/** The opening of a thought, as one line.
 *
 *  Reasoning is written in paragraphs and often starts with a heading or a
 *  restatement of the task, so the first non-empty line carries most of the
 *  signal. Markdown punctuation is stripped because this renders as plain text
 *  in a single row. */
function summarise(content: string): string {
  const line = content
    .split("\n")
    .map((entry) => entry.replace(/^[#>*\-\s]+/, "").trim())
    .find((entry) => entry.length > 0)
  if (line === undefined) return ""
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}



/** The model's reasoning, one muted line that opens to the full text. */
function Thought(props: { content: string; streaming: boolean }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="block thinking" classList={{ open: open(), streaming: props.streaming }}>
      <button class="disclosure" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="chevron">{open() ? "\u25be" : "\u25b8"}</span>
        <span class="tool-title">{props.streaming ? "Thinking…" : "Thought"}</span>
        <Show when={!open()}>
          <span class="tool-detail">{summarise(props.content)}</span>
        </Show>
      </button>
      <Show when={open()}>
        <Markdown class="thinking-body" source={props.content} />
      </Show>
    </div>
  )
}

/** A runtime-injected message: the prompt of an agent of a workflow, a system nudge. It is
 *  plumbing the person can inspect, not something they said, so it renders the
 *  way the TUI renders it: one muted line, the body one click away. */
function InjectedMessage(props: { content: string }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="block injected" classList={{ open: open() }}>
      <button class="disclosure" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <span class="chevron">{open() ? "\u25be" : "\u25b8"}</span>
        <span class="tool-title">{"\u21b3 System"}</span>
        <Show when={!open()}>
          <span class="tool-detail">{summarise(props.content)}</span>
        </Show>
      </button>
      <Show when={open()}>
        <Markdown class="thinking-body" source={props.content} />
      </Show>
    </div>
  )
}

export interface ToolProps {
  meta?: JSX.Element
  entry: FrontendToolEntry
  sessionId: string
  disclosure: BlockDisclosure
  body?: HydratedOutputBlockBody | undefined
  mutationEvidence?: MutationEvidenceReader | undefined
  canOpenFiles: boolean
  onOpenFile: (path: string, asDiff?: boolean) => void
  onSelectSession: (sessionId: string, label: string) => void
  onHydrate: (blockId: string) => void
  onTerminateBackground: (toolUseId: string) => void
  onDetachBash: (toolUseId: string) => void
  working: (key: string) => boolean
  streaming?: FrontendToolStreamingText | undefined
  processStatus?: BlockProps["processStatus"]
  writeSyntaxTheme: WriteSyntaxThemeId
  disclosureId?: string
}

function Tool(props: ToolProps) {
  const tool = createToolPresentation(props)
  return (
    <div class="block tool chain" classList={{ open: tool.open(), [`status-${props.entry.status}`]: true, "execute-summary": props.entry.runCategoryOverride === "execute" }}>
      <div class="tool-head">
        <button class="disclosure" classList={{ static: tool.static() }} aria-expanded={tool.expanded()} title={tool.hint()} onClick={tool.activate}>
          {tool.marker}{tool.label}
        </button>
        {props.meta}
        {tool.actions}
      </div>
      {tool.notices}
      {tool.body}
    </div>
  )
}

/** Ordinary tool capabilities without a wrapper or disclosure header. The caller
 * supplies the disclosure identity, so a stretch can keep its existing owner.
 * Each slot creates its own nodes. Read the body in its persistent owner;
 * header slots can mount separately as the stretch presentation changes. */
export function createToolPresentation(props: ToolProps) {
  const extensions = useClientExtensions()
  const disclosureKey = () => props.disclosureId ?? `tool:${props.entry.id}`
  const disclosure = () => props.disclosure.state(props.sessionId, disclosureKey())()
  const open = () => disclosure().open
  const title = () => rowPresentation(props.entry, activity().active).name
  const linkedSession = () => parseSessionLink(props.entry.linkUri)?.sessionId
  // A file tool's presentation carries no detail; its paths sit in the diff,
  // which every row here keeps folded. So the row names the files itself, the
  // way a subagent's compact rows do in the terminal, and a three-file patch
  // reads as more than a bare "Edit".
  const detail = () => toolRowDetail(props.entry, activity().active) || fileChangeDetail(fileChangeBody())
  const hidesMessageOutput = () => props.entry.name === "message_session"
    && (invocationBody() !== undefined || (props.entry.invocationBodyOmittedBytes ?? 0) > 0 || props.entry.status === "error" || props.entry.status === "blocked")

  /** How much of this body the wire left out. The runtime truncates a tool body
   *  to a preview and states the loss in these three counts; a view that reads
   *  the preview and ignores them tells the reader an excerpt is the whole
   *  thing, which for a diff means reviewing a flattering part of a change. */
  const omitted = () => ({
    diffLines: hasEvidenceReference() ? 0 : totalDiffOmittedLines(props.entry.diffOmission),
    contentLines: suppressesShellOutput() || hidesMessageOutput() ? 0 : props.entry.contentOmittedLines ?? 0,
    invocationBytes: props.entry.invocationBodyOmittedBytes ?? 0,
  })
  const anyOmitted = () => {
    const o = omitted()
    return o.diffLines > 0 || o.contentLines > 0 || o.invocationBytes > 0
  }
  const hydrated = () => props.body
  const fileChangeBody = createMemo(() => selectFileChangeBody(props.entry, props.streaming, hydrated()))
  const hasEvidenceReference = () => {
    const body = fileChangeBody()
    return body.kind === "actual" && body.mutationEvidence !== undefined
  }
  const fileBodyMode = createMemo(() => toolFileBodyMode(props.entry, fileChangeBody()))
  const singleFileChange = () => props.entry.fileChangeKind === "create" || props.entry.fileChangeKind === "replace"
  const suppressesShellOutput = () => isShellMutationEntry(props.entry)
    && !showsShellMutationOutput(props.entry, activity().active, hydrated())

  // A body the wire dropped entirely still has something to show, so the row
  // must not disable its own disclosure and assert there is nothing there.
  const output = () => suppressesShellOutput() || hidesMessageOutput() ? undefined : props.entry.content ?? props.streaming?.content
  const hasBody = () =>
    fileBodyMode().bodyAvailable
    && (
      Boolean(props.entry.diff ?? output() ?? props.entry.invocationBody)
      || anyOmitted()
      || hydrated() !== undefined
      || fileChangeBody().kind !== "unavailable"
      || (props.entry.name === "message_session" && (props.entry.status === "error" || props.entry.status === "blocked"))
    )

  const diffBody = () => hydrated()?.diff ?? props.entry.diff
  const contentBody = () => hidesMessageOutput()
    ? undefined
    : props.streaming?.content ?? hydrated()?.content ?? props.entry.content
  const invocationBody = () => hydrated()?.invocationBody ?? props.entry.invocationBody
  const filetype = () => hydrated()?.filetype ?? props.entry.filetype ?? props.streaming?.filetype
  // A Write body is file rows or plain code, so its palette scopes the whole body.
  const writeSyntax = createMemo(() => writeSyntaxPresentation(props.entry.fileChangeKind, props.writeSyntaxTheme))

  const activity = createMemo(() => toolActivity(props.entry, toolProcess(props.processStatus, props.entry.id)))
  const waitingForProcessor = createMemo(() => waitsForProcessor(activity(), props.processStatus?.processorHeldToolCallIds.includes(props.entry.id) ?? false))

  // A row arrives collapsed and stays that way until the person opens it, an
  // edit or a write included. Live output and a streaming diff render only
  // inside a row they have opened, so a turn never unfolds the transcript
  // under a reader's thumb, and the resting state of every row is the same.

  // While the expansion's own hydration request is in flight, the omission
  // notice stays hidden: rendering "Load the rest" for the beat before the
  // rest arrives flashed a control nobody could meaningfully use. The notice
  // resurfaces only if the request produces nothing, so a truncated body is
  // still never passed off as whole.
  const [awaitingHydration, setAwaitingHydration] = createSignal(false)
  let hydrationRequested = false
  const requestHydration = () => {
    hydrationRequested = true
    props.onHydrate(props.entry.id)
    setAwaitingHydration(true)
    setTimeout(() => setAwaitingHydration(false), 4000)
  }
  createEffect(() => {
    if (!hasEvidenceReference() && hasBody() && open() && anyOmitted() && hydrated() === undefined && !hydrationRequested) requestHydration()
  })

  const expand = () => {
    props.disclosure.setOpen(props.sessionId, disclosureKey(), true)
  }

  // A row with nothing to open is static, never disabled: a disabled button
  // dims, and a dimmed row reads as work that failed or was skipped. Running
  // work is the one thing the marker column signals: a pulsing dot while the
  // call is in flight, then the chevron or the resting dot the row settles to.
  return {
    open,
    static: () => !hasBody() && linkedSession() === undefined,
    expanded: () => linkedSession() === undefined && hasBody() ? open() : undefined,
    hint: () => linkedSession() !== undefined ? "Open this run's own session" : undefined,
    activate: () => {
      const uri = props.entry.linkUri
      if (uri !== undefined && extensions.some(extension => extension.openUri(uri))) return
      const target = linkedSession()
      if (target !== undefined) { props.onSelectSession(target, title()); return }
      if (!hasBody()) return
      if (open()) props.disclosure.setOpen(props.sessionId, disclosureKey(), false)
      else expand()
    },
    get marker() { return <span class="chevron">{activity().active ? <span class="marker-dot live" /> : linkedSession() !== undefined ? "\u2197" : open() ? "▾" : hasBody() ? "▸" : <span class="marker-dot" />}</span> },
    get label() { return <>
      <span class="tool-title">{title()}</span>
      <Show when={detail()}><span class="tool-detail">{detail()}</span></Show>
      <Show when={props.entry.exitCode !== undefined && props.entry.exitCode !== 0}>
        <span class="exit-code">exit {props.entry.exitCode}</span>
      </Show>
    </> },
    /* Controls sit beside the disclosure button, never inside it, and cover
       the command tail so that they do not add a second line. */
    get actions() { return <Show when={activity().control !== undefined || waitingForProcessor()}>
          <div class="tool-actions">
            {/* A held command still runs, so the note sits beside its
                control and the row keeps its live marker. */}
            <Show when={waitingForProcessor()}>
              <span class="processor-wait">{PROCESSOR_WAIT_NOTE}</span>
            </Show>
            <Show when={activity().control === "stop"}>
              <button
                class="tool-action"
                title="Stop this background task. The turn keeps going."
                aria-busy={props.working(actionKey("stop-tool", props.entry.id)) || undefined}
                onClick={() => props.onTerminateBackground(props.entry.id)}
              >
                Stop
              </button>
            </Show>
            {/* Detach applies to a foreground command holding the turn open. Once
                it is already in the background there is nothing left to release. */}
            <Show when={activity().control === "detach"}>
              <button
                class="tool-action"
                title="Let the turn continue while this keeps running"
                aria-busy={props.working(actionKey("detach", props.entry.id)) || undefined}
                onClick={() => props.onDetachBash(props.entry.id)}
              >
                Detach
              </button>
            </Show>
          </div>
        </Show> },
    get notices() { return <>
      <Show when={props.entry.status === "error" && props.entry.name !== "message_session"}>
        <div class="tool-error">{"errorMessage" in props.entry ? props.entry.errorMessage : ""}</div>
      </Show>
      {/* A call whose work waits, such as a held message, did not fail: its
          line is a notice, as the terminal colors it. */}
      <Show when={props.entry.status === "blocked" && props.entry.name !== "message_session"}>
        <div class="tool-notice">{"statusMessage" in props.entry ? props.entry.statusMessage : ""}</div>
      </Show>
      <Show when={fileBodyMode().advisory}>
        {(advisory) => <div class="tool-advisory">Preview check: {advisory()}</div>}
      </Show>
      <Show when={(props.entry.mutationEvidence?.conflictMarkers ?? 0) > 0 ? props.entry.mutationEvidence : undefined}>
        {(summary) => <div class="tool-notice">{conflictMarkersNotice(summary())}</div>}
      </Show>
      <Show when={(props.entry.mutationEvidence?.notApplied ?? 0) > 0 ? props.entry.mutationEvidence : undefined}>
        {(summary) => <div class="tool-notice">{notAppliedNotice(summary())}</div>}
      </Show>
    </> },
    get body() { return <Show when={open() && hasBody()}>
        <div class="tool-body" classList={{ "write-syntax": writeSyntax().class !== undefined }} style={writeSyntax().style}>
          <Show when={props.entry.name === "message_session" && props.entry.status === "error"}>
            <div class="tool-error">{"errorMessage" in props.entry ? props.entry.errorMessage : ""}</div>
          </Show>
          <Show when={props.entry.name === "message_session" && props.entry.status === "blocked"}>
            <div class="tool-notice">{"statusMessage" in props.entry ? props.entry.statusMessage : ""}</div>
          </Show>
          <Show when={invocationBody()}>
            {(body) => {
              const source = createMemo(() => body().content)
              const language = createMemo(() => body().filetype)
              const html = createMemo(() => renderCode(source(), language()))
              return <pre class="code" classList={{ "message-text": props.entry.name === "message_session" }} innerHTML={html()} />
            }}
          </Show>
          <Show when={fileChangeBody().kind !== "unavailable"}>
            <FileDiff
              body={fileChangeBody()}
              evidenceReader={props.mutationEvidence}
              evidenceOwner={props.entry.id}
              writes={rowWritePolicy(props.entry)}
              writeSyntaxTheme={props.writeSyntaxTheme}
              fileExpanded={(file) => props.disclosure.fileExpanded(props.sessionId, disclosureKey(), file, singleFileChange())}
              onToggleFile={(file) => props.disclosure.setFileExpanded(props.sessionId, disclosureKey(), file, !file.expanded, singleFileChange())}
              onOpenFile={props.canOpenFiles ? (path) => props.onOpenFile(path, true) : undefined}
            />
          </Show>
          {/* A diff is evidence of a write that already happened, so the diff
              itself is the way into the editor: no extra row of buttons. */}
          <Show when={fileChangeBody().kind === "unavailable" ? diffBody() : undefined}>
            {(diff) => {
              const source = createMemo(diff)
              const html = createMemo(() => renderDiff(source()))
              return (
                <div
                  innerHTML={html()}
                />
              )
            }}
          </Show>
          {/* A read's file opens from the path above what it read, as a
              diff's file opens from its own header. */}
          <Show when={props.canOpenFiles ? readRowPath(props.entry) : undefined}>
            {(path) => <button class="tool-file-path" title="Open this file in the editor" onClick={() => props.onOpenFile(path())}>{props.entry.presentation.detail}</button>}
          </Show>
          <Show when={suppressesShellOutput() || hasEvidenceReference() ? undefined : contentBody()}>
            {(content) => {
              const source = createMemo(content)
              const language = createMemo(filetype)
              const html = createMemo(() => renderCode(source(), language()))
              return <pre class="code" innerHTML={html()} />
            }}
          </Show>
          {/* What is missing is stated where the reader is looking, not left to
              be inferred from a body that simply stops. */}
          <Show when={!hasEvidenceReference() && anyOmitted() && hydrated() === undefined && !awaitingHydration()}>
            <div class="omitted">
              <Show when={omitted().diffLines > 0}><span>{omitted().diffLines} more diff lines</span></Show>
              <Show when={omitted().contentLines > 0}><span>{omitted().contentLines} more output lines</span></Show>
              <Show when={omitted().invocationBytes > 0}><span>{omitted().invocationBytes} more bytes</span></Show>
              <button class="hydrate" onClick={requestHydration}>Load the rest</button>
            </div>
          </Show>
        </div>
      </Show> },
  }
}

/** The transcript's record of a question. While the question is pending the
 *  composer's panel owns it and nothing renders here, as in the TUI; once it
 *  resolves it reads like a tool run: an "Ask User" heading with each question
 *  as its own railed row, the title where a tool name goes and the answer as
 *  the detail. */
function QuestionRecord(props: { block: FrontendQuestionBlock }) {
  const settled = () => props.block.answers !== undefined || props.block.cancelled === true
  return (
    <Show when={settled()}>
      <div class="block question-record chain">
        <div class="disclosure static">
          <span class="chevron"><span class="marker-dot" /></span>
          <span class="tool-title">Ask User</span>
        </div>
        <div class="group-body">
          <For each={questionRecordRows(props.block)}>
            {(row) => (
              <div class="block tool chain" classList={{ [`status-${row.status}`]: true }}>
                <div class="disclosure static">
                  <span class="chevron"><span class="marker-dot" /></span>
                  <span class="question-record-text">
                    <span class="tool-title">{row.title}</span>{" "}
                    <span class="tool-detail" classList={{ "tool-detail-error": row.status === "error" }}>{row.detail}</span>
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
